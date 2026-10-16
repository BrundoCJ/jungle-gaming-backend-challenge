import { InvalidWagerTransactionError } from '../../../../shared/domain/domain-error';
import { type EventContext, IntegrationEvent } from '../../../../shared/domain/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { FailureCode } from '../failure-code';
import {
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction';

interface WagerTransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function refOf(tx: WagerTransaction): WagerTransactionRef {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus): void {
  if (tx.status !== expected) {
    throw new InvalidWagerTransactionError(
      `cannot raise a ${expected} event for transaction ${tx.id} in ${tx.status}`,
    );
  }
}

export interface WagerTransactionProcessedData extends WagerTransactionRef {
  referenceTransactionId?: string;
  /** Wallet balance right after this transaction was applied. */
  balance: MoneyProps;
}

/** Any applied transaction, including LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed);
    if (!tx.observedBalance) {
      throw new InvalidWagerTransactionError(`processed transaction ${tx.id} has no balance`);
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...refOf(tx),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balance: tx.observedBalance.toJSON(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionRef {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected);
    if (!tx.failureCode) {
      throw new InvalidWagerTransactionError(`rejected transaction ${tx.id} has no failure code`);
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: { ...refOf(tx), failureCode: tx.failureCode },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionRef {
  referenceExternalTransactionId: string;
  attempt: number;
  nextCheckAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference);
    if (!tx.referenceExternalTransactionId || !tx.nextReferenceCheckAt) {
      throw new InvalidWagerTransactionError(`pending transaction ${tx.id} has no reference`);
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...refOf(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        attempt: tx.referenceAttempts,
        nextCheckAt: tx.nextReferenceCheckAt.toISOString(),
      },
    });
  }
}
