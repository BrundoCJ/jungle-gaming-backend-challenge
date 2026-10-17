import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../platform/config/app-config';
import { PollingLoop } from '../../../platform/workers/polling-loop';
import { Clock, IdGenerator } from '../../../shared/application/clock';
import { runWithLogContext } from '../../../shared/application/log-context';
import { MetricsRecorder } from '../../../shared/application/metrics';
import { UnitOfWork } from '../../../shared/application/unit-of-work';
import { settleAndPersist } from '../application/wager-settlement-writer';
import { WagerTransactionStatus } from '../domain/wager-transaction';

export const PENDING_REFERENCE_BATCH = 50;

/**
 * Re-evaluates PENDING_REFERENCE transactions whose next check is due.
 * Each one runs in its own transaction with the same lock order as the
 * request path (wallet row first, then the transaction), and re-checks the
 * status after locking, so any number of workers can run concurrently.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private readonly loop: PollingLoop;

  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(IdGenerator) private readonly ids: IdGenerator,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(MetricsRecorder) private readonly metrics?: MetricsRecorder,
  ) {
    this.loop = new PollingLoop(
      PendingReferenceWorker.name,
      async () => (await this.runOnce()) === PENDING_REFERENCE_BATCH,
      config.workers.pendingReferencePollIntervalMs,
      this.logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.workers.pendingReference) {
      this.loop.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** Processes due transactions; returns how many were examined. */
  async runOnce(now: Date = this.clock.now()): Promise<number> {
    const due = await this.uow.read((repos) =>
      repos.transactions.findDuePendingReferences(now, PENDING_REFERENCE_BATCH),
    );

    for (const candidate of due) {
      await runWithLogContext(
        { correlationId: candidate.id, transactionId: candidate.id, walletId: candidate.walletId },
        () =>
          this.uow.transaction(async (repos) => {
            const wallet = await repos.wallets.findById(candidate.walletId, { forUpdate: true });
            const transaction = await repos.transactions.findById(candidate.id);
            const stillDue =
              transaction?.status === WagerTransactionStatus.PendingReference &&
              (transaction.nextReferenceCheckAt?.getTime() ?? 0) <= now.getTime();
            if (!wallet || !transaction || !stillDue) {
              return; // another worker (or a replay) already handled it
            }
            const { decision } = await settleAndPersist(repos, this.ids, transaction, wallet, {
              isNew: false,
              at: now,
            });
            this.logger.log(`pending reference ${candidate.id}: ${decision.type}`);
            if (transaction.isTerminal()) {
              this.metrics?.transactionSettled(transaction.kind, transaction.status, 'worker');
            }
          }),
      ).catch((error: unknown) => {
        this.logger.warn(`pending reference ${candidate.id} failed: ${String(error)}`);
      });
    }
    return due.length;
  }
}
