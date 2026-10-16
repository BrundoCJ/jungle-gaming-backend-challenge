import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { LedgerDirection } from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
} from '../../../src/shared/domain/domain-error';
import { Money } from '../../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:01:00Z');

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    at: t0,
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
  });
}

const movement = (amount: string, n = 1) => ({
  money: brl(amount),
  transactionId: `tx-${n}`,
  entryId: `entry-${n}`,
  at: t1,
});

describe('Wallet.open', () => {
  it('starts at version 1 with an OPENING credit for a positive balance', () => {
    const { wallet, openingEntry } = openWallet('100.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry).toMatchObject({
      direction: LedgerDirection.Credit,
      transactionId: 'tx-opening',
      walletVersion: 1,
    });
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  it('produces no ledger entry for an empty wallet', () => {
    const { wallet, openingEntry } = openWallet('0');

    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeNull();
  });
});

describe('Wallet movements', () => {
  it('debits, bumps the version and returns the matching entry', () => {
    const { wallet } = openWallet('100.00');

    const entry = wallet.debit(movement('25.00'));

    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(t1);
    expect(entry).toMatchObject({ direction: LedgerDirection.Debit, walletVersion: 2 });
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  it('credits through apply()', () => {
    const { wallet } = openWallet('10.00');

    const entry = wallet.apply(LedgerDirection.Credit, movement('5.50'));

    expect(wallet.balance.amount).toBe('15.50');
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it('allows debiting the exact balance down to zero', () => {
    const { wallet } = openWallet('80.00');
    wallet.debit(movement('80.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('never goes negative and leaves state untouched on insufficient funds', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(movement('80.00', 1));

    expect(wallet.canDebit(brl('80.00'))).toBe(false);
    expect(() => wallet.debit(movement('80.00', 2))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  it('rejects a movement in another currency without changing state', () => {
    const { wallet } = openWallet('100.00');
    const foreign = { ...movement('1.00'), money: usd('1.00') };

    expect(() => wallet.credit(foreign)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(foreign)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  it('rejects zero-amount movements (version only changes with the balance)', () => {
    const { wallet } = openWallet('100.00');

    expect(() => wallet.credit(movement('0'))).toThrow(InvalidLedgerEntryError);
    expect(wallet.version).toBe(1);
  });

  it('keeps balance equal to the sum of its ledger', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries = [
      wallet.debit(movement('30.00', 1)),
      wallet.credit(movement('12.34', 2)),
      wallet.debit(movement('0.01', 3)),
    ];

    const fromLedger = [openingEntry, ...entries].reduce(
      (sum, entry) => (entry ? sum.add(entry.signedAmount()) : sum),
      Money.zero('BRL'),
    );
    expect(fromLedger.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(4);
  });
});

describe('Wallet.rehydrate', () => {
  it('restores persisted state as-is', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: t0,
      updatedAt: t1,
    });

    expect(wallet.balance.amount).toBe('42.00');
    expect(wallet.version).toBe(7);
  });
});
