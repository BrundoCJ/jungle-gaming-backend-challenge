import { describe, expect, it } from 'bun:test';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../src/modules/wagering/domain/events/wager-transaction-events';
import { FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import { DEFAULT_REFERENCE_RETRY_POLICY } from '../../../src/modules/wagering/domain/wager-transaction';
import { WalletBalanceChanged } from '../../../src/modules/wallet/domain/events/wallet-balance-changed';
import { LedgerDirection } from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import { InvalidWagerTransactionError } from '../../../src/shared/domain/domain-error';
import { aTransaction, aWallet, brl, Kind, T0, T1 } from '../../support/builders';

const ctx = {
  eventId: 'evt-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: T1,
};

describe('WalletBalanceChanged', () => {
  it('serializes the envelope with money as decimal strings', () => {
    const wallet = aWallet('100.00');
    const entry = wallet.debit({
      money: brl('25.00'),
      transactionId: 'tx-1',
      entryId: 'e-1',
      at: T1,
    });

    const envelope = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();

    expect(envelope).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-01-01T00:01:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('round-trips through JSON unchanged', () => {
    const wallet = aWallet('10.00');
    const entry = wallet.credit({ money: brl('1.00'), transactionId: 't', entryId: 'e', at: T1 });
    const envelope = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();

    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });
});

describe('wager transaction events', () => {
  it('WagerTransactionProcessed carries the observed balance', () => {
    const loss = aTransaction(Kind.Loss);
    loss.markProcessed({
      referenceTransactionId: undefined,
      observedBalance: brl('100.00'),
      at: T1,
    });

    const envelope = WagerTransactionProcessed.from(loss, {
      ...ctx,
      causationId: undefined,
    }).toJSON();

    expect(envelope.eventType).toBe('WagerTransactionProcessed');
    expect(envelope.aggregateId).toBe(loss.id);
    expect(envelope).not.toHaveProperty('causationId');
    expect(envelope.data).toMatchObject({
      kind: 'LOSS',
      balance: { amount: '100.00', currency: 'BRL' },
    });
  });

  it('WagerTransactionRejected carries the failure code', () => {
    const bet = aTransaction(Kind.Bet);
    bet.reject(FailureCode.InsufficientFunds, { observedBalance: brl('1.00'), at: T1 });

    const envelope = WagerTransactionRejected.from(bet, ctx).toJSON();

    expect(envelope.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(envelope.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('WagerTransactionPendingReference carries the next check', () => {
    const refund = aTransaction(Kind.Refund, { referenceExternalTransactionId: 'bet-x' });
    refund.markPendingReference(T0, DEFAULT_REFERENCE_RETRY_POLICY);

    const envelope = WagerTransactionPendingReference.from(refund, ctx).toJSON();

    expect(envelope.data).toMatchObject({
      referenceExternalTransactionId: 'bet-x',
      attempt: 1,
      nextCheckAt: '2026-01-01T00:00:01.000Z',
    });
  });

  it('refuses to raise an event that contradicts the transaction state', () => {
    const pending = aTransaction(Kind.Bet);

    expect(() => WagerTransactionProcessed.from(pending, ctx)).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => WagerTransactionRejected.from(pending, ctx)).toThrow(InvalidWagerTransactionError);
  });

  it('freezes event data', () => {
    const loss = aTransaction(Kind.Loss);
    loss.markProcessed({ referenceTransactionId: undefined, observedBalance: brl('1.00'), at: T1 });

    expect(Object.isFrozen(WagerTransactionProcessed.from(loss, ctx).data)).toBe(true);
  });
});
