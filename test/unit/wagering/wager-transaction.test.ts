import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  WagerTransaction,
  WagerTransactionStatus,
} from '../../../src/modules/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../src/shared/domain/domain-error';
import { aProcessed, aTransaction, brl, Kind, T0, T1 } from '../../support/builders';

describe('WagerTransaction.create', () => {
  it('starts PENDING', () => {
    const tx = aTransaction(Kind.Bet);

    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  it.each([Kind.Refund, Kind.Rollback])('requires a reference for %s', (kind) => {
    expect(() => aTransaction(kind)).toThrow(InvalidWagerTransactionError);
    expect(() => aTransaction(kind, { referenceExternalTransactionId: 'ext-bet' })).not.toThrow();
  });

  it('allows WIN and LOSS to optionally reference a BET', () => {
    expect(() => aTransaction(Kind.Win)).not.toThrow();
    expect(() => aTransaction(Kind.Loss, { referenceExternalTransactionId: 'b' })).not.toThrow();
  });

  it('rejects a BET with a reference', () => {
    expect(() => aTransaction(Kind.Bet, { referenceExternalTransactionId: 'x' })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it('rejects a self reference', () => {
    expect(() =>
      aTransaction(Kind.Refund, {
        externalTransactionId: 'same',
        referenceExternalTransactionId: 'same',
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  it('rejects OPENING from providers', () => {
    expect(() => aTransaction(Kind.Opening)).toThrow(InvalidWagerTransactionError);
  });

  it.each([Kind.Bet, Kind.Win])('requires a positive amount for %s', (kind) => {
    expect(() => aTransaction(kind, { money: brl('0') })).toThrow(InvalidWagerTransactionError);
  });

  it('accepts a zero-amount LOSS', () => {
    expect(() => aTransaction(Kind.Loss, { money: brl('0') })).not.toThrow();
  });
});

describe('WagerTransaction transitions', () => {
  const at = T1;

  it('PENDING -> PROCESSED records reference, observed balance and time', () => {
    const tx = aTransaction(Kind.Bet);

    tx.markProcessed({ referenceTransactionId: 'ref-1', observedBalance: brl('75.00'), at });

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('ref-1');
    expect(tx.observedBalance?.amount).toBe('75.00');
    expect(tx.processedAt).toEqual(at);
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING -> REJECTED carries a failure code', () => {
    const tx = aTransaction(Kind.Bet);

    tx.reject(FailureCode.InsufficientFunds, { observedBalance: brl('20.00'), at });

    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  it('PENDING -> FAILED is terminal and auditable', () => {
    const tx = aTransaction(Kind.Bet);

    tx.fail(FailureCode.ProcessingFailed, at);

    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.failureCode).toBe(FailureCode.ProcessingFailed);
  });

  it('PENDING_REFERENCE schedules checks with exponential backoff', () => {
    const tx = aTransaction(Kind.Refund, { referenceExternalTransactionId: 'missing' });

    tx.markPendingReference(T0, DEFAULT_REFERENCE_RETRY_POLICY);
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.nextReferenceCheckAt?.getTime()).toBe(T0.getTime() + 1_000);

    tx.markPendingReference(T0, DEFAULT_REFERENCE_RETRY_POLICY);
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceCheckAt?.getTime()).toBe(T0.getTime() + 2_000);

    tx.markProcessed({ referenceTransactionId: 'ref', observedBalance: brl('1.00'), at });
    expect(tx.nextReferenceCheckAt).toBeUndefined();
  });

  it('reports when reference retries are exhausted', () => {
    const tx = aTransaction(Kind.Rollback, { referenceExternalTransactionId: 'missing' });
    const policy = { ...DEFAULT_REFERENCE_RETRY_POLICY, maxAttempts: 2 };

    tx.markPendingReference(T0, policy);
    expect(tx.referenceRetriesExhausted(policy)).toBe(false);
    tx.markPendingReference(T0, policy);
    expect(tx.referenceRetriesExhausted(policy)).toBe(true);
  });

  it.each([
    [
      'PROCESSED',
      (tx: WagerTransaction) =>
        tx.markProcessed({ referenceTransactionId: undefined, observedBalance: brl('1.00'), at }),
    ],
    [
      'REJECTED',
      (tx: WagerTransaction) =>
        tx.reject(FailureCode.InsufficientFunds, { observedBalance: undefined, at }),
    ],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed, at)],
  ])('never leaves the terminal state %s', (_state, toTerminal) => {
    const tx = aTransaction(Kind.Bet);
    toTerminal(tx);

    expect(() =>
      tx.markProcessed({ referenceTransactionId: undefined, observedBalance: brl('1.00'), at }),
    ).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.AmountMismatch, { observedBalance: undefined, at })).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(FailureCode.ProcessingFailed, at)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(at, DEFAULT_REFERENCE_RETRY_POLICY)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransaction queries', () => {
  it('LOSS does not affect the balance', () => {
    expect(aTransaction(Kind.Loss).affectsBalance()).toBe(false);
    expect(aTransaction(Kind.Bet).affectsBalance()).toBe(true);
  });

  it('only REFUND and ROLLBACK require a reference', () => {
    expect(
      aTransaction(Kind.Refund, { referenceExternalTransactionId: 'b' }).requiresReference(),
    ).toBe(true);
    expect(aTransaction(Kind.Win).requiresReference()).toBe(false);
  });

  it('matches its own payload hash only', () => {
    const tx = aTransaction(Kind.Bet, { payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });

  it.each([
    [Kind.Bet, LedgerDirection.Debit],
    [Kind.Win, LedgerDirection.Credit],
    [Kind.Refund, LedgerDirection.Credit],
  ])('%s has a fixed direction (%s)', (kind, direction) => {
    const tx = aTransaction(
      kind,
      kind === Kind.Refund ? { referenceExternalTransactionId: 'b' } : {},
    );
    expect(tx.ledgerDirectionFor()).toBe(direction);
  });

  it.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ])('ROLLBACK of %s inverts it (%s)', (referenceKind, expected) => {
    const reference = aProcessed(
      referenceKind,
      referenceKind === Kind.Refund ? { referenceExternalTransactionId: 'b' } : {},
    );
    const rollback = aTransaction(Kind.Rollback, {
      referenceExternalTransactionId: reference.externalTransactionId,
    });

    expect(rollback.ledgerDirectionFor(reference)).toBe(expected);
  });

  it('LOSS has no ledger direction', () => {
    expect(() => aTransaction(Kind.Loss).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction.opening', () => {
  it('is internal and already PROCESSED', () => {
    const opening = WagerTransaction.opening({
      id: 'tx-open',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1000.00'),
      payloadHash: 'hash',
      at: T0,
    });

    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.providerId).toBe('internal');
    expect(opening.observedBalance?.amount).toBe('1000.00');
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});
