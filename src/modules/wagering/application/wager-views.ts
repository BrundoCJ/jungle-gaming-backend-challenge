import type { MoneyProps } from '../../../shared/domain/money';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import type { WagerOutcome } from './process-wager-transaction';

export interface WagerResultView {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export function toResultView(outcome: WagerOutcome): WagerResultView {
  const { transaction } = outcome;
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: outcome.balance.toJSON(),
    idempotentReplay: outcome.idempotentReplay,
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
  };
}

/** HTTP status per outcome; identical for the original response and its replays. */
export function httpStatusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 201;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export function toTransactionView(tx: WagerTransaction): WagerTransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    balanceAfter: tx.observedBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}
