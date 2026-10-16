import { Inject, Injectable } from '@nestjs/common';
import { bindLogContext } from '../../../platform/logging/log-context';
import { Clock, IdGenerator } from '../../../shared/application/clock';
import {
  ConflictError,
  PoisonMessageError,
  UnprocessableError,
} from '../../../shared/application/errors';
import { type Repositories, UnitOfWork } from '../../../shared/application/unit-of-work';
import { Money } from '../../../shared/domain/money';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import { FailureCode } from '../domain/failure-code';
import { type WagerPayload, wagerPayloadHash } from '../domain/wager-payload';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import { settleAndPersist } from './wager-settlement-writer';

/** Where the request came from. SQS requests are deduplicated by the inbox too. */
export type WagerSource =
  | { channel: 'http' }
  | { channel: 'sqs'; consumerName: string; messageId: string; messageHash: string };

export interface ProcessWagerCommand {
  payload: WagerPayload & { kind: WagerTransactionKind };
  /** Source of truth for idempotency (HTTP header or message field). */
  idempotencyKey: string;
  source: WagerSource;
}

export interface WagerOutcome {
  transaction: WagerTransaction;
  /** Balance observed when the transaction was settled (the original one on replays). */
  balance: Money;
  idempotentReplay: boolean;
}

/**
 * The single entry point for provider transactions, used by HTTP and SQS.
 * Everything happens in one SQL transaction:
 *   inbox check -> wallet row lock -> idempotency lookup -> domain decision
 *   -> transaction + ledger + conditional wallet update + outbox (+ inbox).
 * The wallet lock serializes all work on one wallet across every instance,
 * so duplicates and races resolve deterministically.
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(IdGenerator) private readonly ids: IdGenerator,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<WagerOutcome> {
    const { payload, idempotencyKey, source } = command;
    const payloadHash = wagerPayloadHash(payload);
    const money = Money.from(payload.money);
    bindLogContext({ walletId: payload.walletId, providerId: payload.providerId });

    return this.uow.transaction(async (repos) => {
      if (source.channel === 'sqs') {
        const seen = await repos.inbox.find(source.consumerName, source.messageId);
        if (seen && !seen.matchesPayload(source.messageHash)) {
          throw new PoisonMessageError(
            'MESSAGE_ID_REUSED',
            'messageId redelivered with a different body',
          );
        }
      }

      const wallet = await repos.wallets.findById(payload.walletId, { forUpdate: true });

      const existing = await repos.transactions.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (!existing.matchesPayload(payloadHash)) {
          throw new ConflictError(
            'IDEMPOTENCY_KEY_CONFLICT',
            'Idempotency-Key was already used with a different payload',
          );
        }
        bindLogContext({ transactionId: existing.id });
        await this.recordInbox(repos, source);
        return {
          transaction: existing,
          balance: existing.observedBalance ?? wallet?.balance ?? Money.zero(money.currency),
          idempotentReplay: true,
        };
      }

      if (!wallet) {
        throw new UnprocessableError(
          FailureCode.WalletNotFound,
          `wallet ${payload.walletId} not found`,
        );
      }
      if (
        await repos.transactions.findByExternalId(payload.providerId, payload.externalTransactionId)
      ) {
        throw new ConflictError(
          'EXTERNAL_TRANSACTION_ID_CONFLICT',
          'externalTransactionId was already submitted under another Idempotency-Key',
        );
      }

      const at = this.clock.now();
      const transaction = WagerTransaction.create({
        id: this.ids.next(),
        providerId: payload.providerId,
        externalTransactionId: payload.externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId: payload.walletId,
        playerId: payload.playerId,
        roundId: payload.roundId,
        gameId: payload.gameId,
        kind: payload.kind,
        money,
        referenceExternalTransactionId: payload.referenceExternalTransactionId,
        createdAt: at,
      });
      bindLogContext({ transactionId: transaction.id });

      await settleAndPersist(repos, this.ids, transaction, wallet, {
        isNew: true,
        at,
        causationId: source.channel === 'sqs' ? source.messageId : undefined,
      });
      await this.recordInbox(repos, source);

      return {
        transaction,
        balance: transaction.observedBalance ?? wallet.balance,
        idempotentReplay: false,
      };
    });
  }

  private async recordInbox(repos: Repositories, source: WagerSource): Promise<void> {
    if (source.channel !== 'sqs') {
      return;
    }
    if (await repos.inbox.find(source.consumerName, source.messageId)) {
      return;
    }
    const inbox = InboxMessage.receive({
      messageId: source.messageId,
      consumerName: source.consumerName,
      payloadHash: source.messageHash,
      receivedAt: this.clock.now(),
    });
    inbox.markProcessed(this.clock.now());
    await repos.inbox.insert(inbox);
  }
}
