import { InboxMessage } from '../../../modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../../modules/messaging/domain/outbox-message';
import type { FailureCode } from '../../../modules/wagering/domain/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../../modules/wagering/domain/wager-transaction';
import { Wallet } from '../../../modules/wallet/domain/wallet';
import {
  type LedgerDirection,
  WalletLedgerEntry,
} from '../../../modules/wallet/domain/wallet-ledger-entry';
import { Money } from '../../../shared/domain/money';
import type {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './schemas';

// Persisted money columns are numeric(20,2) and never negative (CHECK
// constraints), so the strict contract parser applies.
const money = (amount: string, currency: string) => Money.from({ amount, currency });
const optional = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function fromWallet(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toTransaction(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: optional(record.referenceExternalTransactionId),
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: optional(record.referenceTransactionId),
    failureCode: optional(record.failureCode) as FailureCode | undefined,
    processedAt: optional(record.processedAt),
    observedBalance:
      record.observedBalance === null ? undefined : money(record.observedBalance, record.currency),
    referenceAttempts: record.referenceAttempts,
    nextReferenceCheckAt: optional(record.nextReferenceCheckAt),
  });
}

type MutableTransactionColumns = Pick<
  WagerTransactionRecord,
  | 'status'
  | 'referenceTransactionId'
  | 'failureCode'
  | 'observedBalance'
  | 'referenceAttempts'
  | 'nextReferenceCheckAt'
  | 'processedAt'
>;

/** Columns a state transition can change. */
export function transactionChanges(tx: WagerTransaction): MutableTransactionColumns {
  return {
    status: tx.status,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    observedBalance: tx.observedBalance?.amount ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceCheckAt: tx.nextReferenceCheckAt ?? null,
    processedAt: tx.processedAt ?? null,
  };
}

export function fromTransaction(tx: WagerTransaction): WagerTransactionRecord {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.amount,
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    createdAt: tx.createdAt,
    ...transactionChanges(tx),
  };
}

export function toLedgerEntry(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}

export function fromLedgerEntry(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

export function toInbox(record: InboxRecord): InboxMessage {
  return InboxMessage.rehydrate({ ...record, processedAt: optional(record.processedAt) });
}

export function fromInbox(message: InboxMessage): InboxRecord {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

export function toOutbox(record: OutboxRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    ...record,
    nextAttemptAt: optional(record.nextAttemptAt),
    publishedAt: optional(record.publishedAt),
  });
}

export function fromOutbox(message: OutboxMessage): OutboxRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
  };
}
