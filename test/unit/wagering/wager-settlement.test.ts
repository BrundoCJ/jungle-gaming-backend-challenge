import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import {
  settleWager,
  type WagerContext,
} from '../../../src/modules/wagering/domain/wager-settlement';
import {
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from '../../../src/modules/wagering/domain/wager-transaction';
import type { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { LedgerDirection } from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import { aProcessed, aTransaction, aWallet, brl, Kind, T1, usd } from '../../support/builders';

function settle(
  transaction: WagerTransaction,
  wallet: Wallet,
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
) {
  const context: WagerContext = { transaction, wallet, reference, referenceAlreadyReversed };
  return settleWager(context, { entryId: `entry-${transaction.id}`, at: T1 });
}

const ref = (reference: WagerTransaction) => ({
  referenceExternalTransactionId: reference.externalTransactionId,
});

describe('BET', () => {
  it('debits the wallet and produces one DEBIT entry', () => {
    const wallet = aWallet('100.00');
    const bet = aTransaction(Kind.Bet, { money: brl('25.00') });

    const { entry } = settle(bet, wallet);

    expect(bet.status).toBe(Status.Processed);
    expect(bet.observedBalance?.amount).toBe('75.00');
    expect(wallet.balance.amount).toBe('75.00');
    expect(entry?.direction).toBe(LedgerDirection.Debit);
  });

  it('is rejected on insufficient funds without moving the balance', () => {
    const wallet = aWallet('100.00');
    settle(aTransaction(Kind.Bet, { money: brl('80.00') }), wallet);
    const second = aTransaction(Kind.Bet, { money: brl('80.00') });

    const { entry } = settle(second, wallet);

    expect(second.status).toBe(Status.Rejected);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(second.observedBalance?.amount).toBe('20.00');
    expect(entry).toBeUndefined();
    expect(wallet.balance.amount).toBe('20.00');
  });

  it('is rejected on currency conflict', () => {
    const wallet = aWallet('100.00');
    const bet = aTransaction(Kind.Bet, { money: usd('10.00') });

    settle(bet, wallet);

    expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(wallet.version).toBe(1);
  });

  it('is rejected when the wallet belongs to another player', () => {
    const wallet = aWallet('100.00', { playerId: 'someone-else' });
    const bet = aTransaction(Kind.Bet);

    settle(bet, wallet);

    expect(bet.failureCode).toBe(FailureCode.PlayerWalletMismatch);
  });
});

describe('WIN', () => {
  it('credits the wallet', () => {
    const wallet = aWallet('10.00');
    const win = aTransaction(Kind.Win, { money: brl('50.00') });

    const { entry } = settle(win, wallet);

    expect(win.status).toBe(Status.Processed);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('60.00');
  });

  it('may reference the BET of the same round', () => {
    const wallet = aWallet('100.00');
    const bet = aProcessed(Kind.Bet);
    const win = aTransaction(Kind.Win, { ...ref(bet), money: brl('40.00') });

    settle(win, wallet, bet);

    expect(win.status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  it('is rejected when the referenced BET is from another round', () => {
    const wallet = aWallet('100.00');
    const bet = aProcessed(Kind.Bet, { roundId: 'round-other' });
    const win = aTransaction(Kind.Win, ref(bet));

    settle(win, wallet, bet);

    expect(win.failureCode).toBe(FailureCode.ReferenceMismatch);
  });
});

describe('LOSS', () => {
  it('records the outcome without moving the balance or writing the ledger', () => {
    const wallet = aWallet('100.00');
    const loss = aTransaction(Kind.Loss);

    const { entry } = settle(loss, wallet);

    expect(loss.status).toBe(Status.Processed);
    expect(entry).toBeUndefined();
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('REFUND', () => {
  it('credits back a PROCESSED BET', () => {
    const wallet = aWallet('75.00');
    const bet = aProcessed(Kind.Bet, { money: brl('25.00') });
    const refund = aTransaction(Kind.Refund, { ...ref(bet), money: brl('25.00') });

    const { entry } = settle(refund, wallet, bet);

    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  it('can only reference a BET', () => {
    const win = aProcessed(Kind.Win);
    const refund = aTransaction(Kind.Refund, ref(win));

    settle(refund, aWallet(), win);

    expect(refund.failureCode).toBe(FailureCode.ReferenceInvalidKind);
  });

  it('must match the referenced amount', () => {
    const bet = aProcessed(Kind.Bet, { money: brl('25.00') });
    const refund = aTransaction(Kind.Refund, { ...ref(bet), money: brl('10.00') });

    settle(refund, aWallet(), bet);

    expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
  });

  it('cannot reverse the same BET twice', () => {
    const wallet = aWallet('75.00');
    const bet = aProcessed(Kind.Bet);
    const refund = aTransaction(Kind.Refund, ref(bet));

    settle(refund, wallet, bet, true);

    expect(refund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(wallet.balance.amount).toBe('75.00');
  });

  it('cannot reverse a BET that was rejected', () => {
    const bet = aTransaction(Kind.Bet);
    bet.reject(FailureCode.InsufficientFunds, { observedBalance: brl('0'), at: T1 });
    const refund = aTransaction(Kind.Refund, ref(bet));

    settle(refund, aWallet(), bet);

    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe('ROLLBACK', () => {
  it('reverses a BET with a credit', () => {
    const wallet = aWallet('75.00');
    const bet = aProcessed(Kind.Bet);
    const rollback = aTransaction(Kind.Rollback, ref(bet));

    const { entry } = settle(rollback, wallet, bet);

    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  it('reverses a WIN with a debit', () => {
    const wallet = aWallet('125.00');
    const win = aProcessed(Kind.Win);
    const rollback = aTransaction(Kind.Rollback, ref(win));

    const { entry } = settle(rollback, wallet, win);

    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  it('is rejected with a distinct code when it would overdraw', () => {
    const wallet = aWallet('5.00');
    const win = aProcessed(Kind.Win, { money: brl('25.00') });
    const rollback = aTransaction(Kind.Rollback, ref(win));

    settle(rollback, wallet, win);

    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(wallet.balance.amount).toBe('5.00');
  });

  it('cannot reference a LOSS', () => {
    const loss = aProcessed(Kind.Loss);
    const rollback = aTransaction(Kind.Rollback, ref(loss));

    settle(rollback, aWallet(), loss);

    expect(rollback.failureCode).toBe(FailureCode.ReferenceInvalidKind);
  });
});

describe('out-of-order references', () => {
  it('parks the transaction when the reference has not arrived', () => {
    const wallet = aWallet('100.00');
    const refund = aTransaction(Kind.Refund, { referenceExternalTransactionId: 'not-yet' });

    const { decision, entry } = settle(refund, wallet, undefined);

    expect(decision.type).toBe('await-reference');
    expect(refund.status).toBe(Status.PendingReference);
    expect(entry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  it('waits while the reference itself is not terminal yet', () => {
    const pendingWin = aTransaction(Kind.Win);
    const rollback = aTransaction(Kind.Rollback, ref(pendingWin));

    settle(rollback, aWallet(), pendingWin);

    expect(rollback.status).toBe(Status.PendingReference);
  });

  it('is processed once the reference shows up', () => {
    const wallet = aWallet('75.00');
    const bet = aProcessed(Kind.Bet);
    const refund = aTransaction(Kind.Refund, ref(bet));
    settle(refund, wallet, undefined);

    settle(refund, wallet, bet);

    expect(refund.status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe('100.00');
  });

  it('is rejected with REFERENCE_NOT_FOUND after the retry budget', () => {
    const wallet = aWallet('100.00');
    const refund = aTransaction(Kind.Refund, { referenceExternalTransactionId: 'never' });
    const policy = { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2 };
    const context: WagerContext = {
      transaction: refund,
      wallet,
      reference: undefined,
      referenceAlreadyReversed: false,
    };

    settleWager(context, { entryId: 'e', at: T1, retryPolicy: policy });
    settleWager(context, { entryId: 'e', at: T1, retryPolicy: policy });
    const { decision } = settleWager(context, { entryId: 'e', at: T1, retryPolicy: policy });

    expect(decision).toEqual({ type: 'reject', code: FailureCode.ReferenceNotFound });
    expect(refund.status).toBe(Status.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
  });
});
