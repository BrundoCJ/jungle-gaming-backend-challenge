import { describe, expect, it } from 'bun:test';
import {
  type CreateLedgerEntryProps,
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import { InvalidLedgerEntryError } from '../../../src/shared/domain/domain-error';
import { Money } from '../../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function props(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    walletVersion: 2,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('WalletLedgerEntry.create', () => {
  it('accepts a balanced debit', () => {
    const entry = WalletLedgerEntry.create(props());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().amount).toBe('-25.00');
  });

  it('accepts a balanced credit', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: brl('125.00') }),
    );
    expect(entry.signedAmount().amount).toBe('25.00');
  });

  it.each<[string, Partial<CreateLedgerEntryProps>]>([
    ['unbalanced arithmetic', { balanceAfter: brl('80.00') }],
    ['wrong direction', { direction: LedgerDirection.Credit }],
    ['zero amount', { money: brl('0'), balanceAfter: brl('100.00') }],
    [
      'negative resulting balance',
      { balanceBefore: brl('10.00'), balanceAfter: brl('10.00').subtract(brl('25.00')) },
    ],
    ['mixed currencies', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['non-positive wallet version', { walletVersion: 0 }],
  ])('rejects %s', (_case, overrides) => {
    expect(() => WalletLedgerEntry.create(props(overrides))).toThrow(InvalidLedgerEntryError);
  });
});

describe('WalletLedgerEntry immutability', () => {
  it('is frozen and exposes no mutators', () => {
    const entry = WalletLedgerEntry.create(props());

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { walletId: string }).walletId = 'other';
    }).toThrow();
  });

  it('rehydrates persisted state without re-validating', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('1.00') }));
    expect(entry.isBalanced()).toBe(false);
  });
});
