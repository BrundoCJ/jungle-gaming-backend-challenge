import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Clock } from '../../../shared/application/clock';
import { MetricsRecorder } from '../../../shared/application/metrics';
import { UnitOfWork } from '../../../shared/application/unit-of-work';
import { EventPublisher } from './event-publisher';

export interface PublishReport {
  claimed: number;
  published: number;
  failed: number;
}

export const OUTBOX_BATCH_SIZE = 25;

/**
 * Publishes pending outbox messages. Rows are claimed with
 * FOR UPDATE SKIP LOCKED inside one transaction, so concurrent publishers
 * (any number of instances) never work on the same row at the same time.
 * If the process dies mid-batch the transaction rolls back, the locks are
 * released and another instance publishes the rows again: delivery is
 * at-least-once and consumers deduplicate by eventId.
 */
@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(EventPublisher) private readonly publisher: EventPublisher,
    @Inject(Clock) private readonly clock: Clock,
    @Optional() @Inject(MetricsRecorder) private readonly metrics?: MetricsRecorder,
  ) {}

  publishPending(limit = OUTBOX_BATCH_SIZE): Promise<PublishReport> {
    return this.uow.transaction(async (repos) => {
      const batch = await repos.outbox.claimDue(this.clock.now(), limit);
      const report: PublishReport = { claimed: batch.length, published: 0, failed: 0 };

      for (const message of batch) {
        try {
          await this.publisher.publish(message);
          message.markPublished(this.clock.now());
          report.published += 1;
        } catch (error) {
          message.scheduleRetry(this.clock.now());
          report.failed += 1;
          this.logger.warn(
            `publish failed for outbox message ${message.id} (attempt ${message.attempts}): ${String(error)}`,
          );
        }
        await repos.outbox.save(message);
      }

      const oldest = await repos.outbox.oldestPendingOccurredAt();
      this.metrics?.outboxLag(
        oldest ? Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000) : 0,
      );
      this.metrics?.outboxPublished(report.published, report.failed);
      return report;
    });
  }
}
