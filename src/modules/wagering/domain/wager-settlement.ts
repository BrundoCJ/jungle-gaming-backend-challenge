import { InvalidWagerTransactionError } from '../../../shared/domain/domain-error';
import type { Wallet } from '../../wallet/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  WagerTransactionKind as Kind,
  type ReferenceRetryPolicy,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from './wager-transaction';

export type WagerDecision =
  | { type: 'apply'; direction: LedgerDirection; reference: WagerTransaction | undefined }
  | { type: 'record'; reference: WagerTransaction | undefined }
  | { type: 'reject'; code: FailureCode }
  | { type: 'await-reference'; referenceExists: boolean };

export interface WagerContext {
  transaction: WagerTransaction;
  /** The transaction's wallet, loaded under lock. */
  wallet: Wallet;
  /** Resolved by (providerId, referenceExternalTransactionId); undefined when absent. */
  reference: WagerTransaction | undefined;
  /** True when a PROCESSED REFUND/ROLLBACK already targets `reference`. */
  referenceAlreadyReversed: boolean;
}

/** Which kinds each operation may reference. */
const REFERENCEABLE: Readonly<Record<Kind, readonly Kind[]>> = {
  [Kind.Opening]: [],
  [Kind.Bet]: [],
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

/** Pure decision: what should happen to this transaction given the current state. */
export function decideWager(context: WagerContext): WagerDecision {
  const { transaction: tx, wallet, reference } = context;

  if (tx.walletId !== wallet.id) {
    throw new InvalidWagerTransactionError('transaction evaluated against the wrong wallet');
  }
  if (wallet.playerId !== tx.playerId) {
    return reject(FailureCode.PlayerWalletMismatch);
  }
  if (wallet.currency !== tx.money.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  if (tx.hasReference()) {
    if (!reference) {
      return { type: 'await-reference', referenceExists: false };
    }
    const problem = checkReference(tx, reference, context.referenceAlreadyReversed);
    if (problem === 'not-ready') {
      return { type: 'await-reference', referenceExists: true };
    }
    if (problem) {
      return reject(problem);
    }
  }

  if (!tx.affectsBalance()) {
    return { type: 'record', reference };
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    // A reversal that cannot be covered is operationally different from an unfunded bet.
    return reject(
      tx.kind === Kind.Rollback ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds,
    );
  }
  return { type: 'apply', direction, reference };
}

function checkReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | 'not-ready' | null {
  const sameScope =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId;
  if (!sameScope) {
    return FailureCode.ReferenceMismatch;
  }
  if (!REFERENCEABLE[tx.kind].includes(reference.kind)) {
    return FailureCode.ReferenceInvalidKind;
  }
  if (!reference.isTerminal()) {
    return 'not-ready';
  }
  if (reference.status !== Status.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  if (tx.requiresReference()) {
    if (!reference.money.equals(tx.money)) {
      return FailureCode.AmountMismatch;
    }
    if (alreadyReversed) {
      return FailureCode.ReferenceAlreadyReversed;
    }
  }
  return null;
}

function reject(code: FailureCode): WagerDecision {
  return { type: 'reject', code };
}

export interface SettleOptions {
  /** Id for the ledger entry, used only if the balance moves. */
  entryId: string;
  at: Date;
  retryPolicy?: ReferenceRetryPolicy;
}

export interface Settlement {
  decision: WagerDecision;
  /** Present only when the balance moved. */
  entry: WalletLedgerEntry | undefined;
}

/**
 * Applies the decision to the aggregates: moves the balance (returning the
 * ledger entry) and transitions the transaction. Once the reference retry
 * budget is spent, a still-missing reference becomes a rejection.
 */
export function settleWager(context: WagerContext, options: SettleOptions): Settlement {
  const { transaction: tx, wallet } = context;
  const policy = options.retryPolicy ?? DEFAULT_REFERENCE_RETRY_POLICY;
  const at = options.at;

  const decision = decideWager(context);
  switch (decision.type) {
    case 'apply': {
      const entry = wallet.apply(decision.direction, {
        money: tx.money,
        transactionId: tx.id,
        entryId: options.entryId,
        at,
      });
      tx.markProcessed({
        referenceTransactionId: decision.reference?.id,
        observedBalance: wallet.balance,
        at,
      });
      return { decision, entry };
    }
    case 'record':
      tx.markProcessed({
        referenceTransactionId: decision.reference?.id,
        observedBalance: wallet.balance,
        at,
      });
      return { decision, entry: undefined };
    case 'reject':
      tx.reject(decision.code, { observedBalance: wallet.balance, at });
      return { decision, entry: undefined };
    case 'await-reference': {
      if (tx.referenceRetriesExhausted(policy)) {
        const code = decision.referenceExists
          ? FailureCode.ReferenceNotProcessed
          : FailureCode.ReferenceNotFound;
        tx.reject(code, { observedBalance: wallet.balance, at });
        return { decision: reject(code), entry: undefined };
      }
      tx.markPendingReference(at, policy);
      return { decision, entry: undefined };
    }
  }
}
