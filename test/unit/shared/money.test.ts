import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/shared/domain/domain-error';
import { Money } from '../../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  it.each([
    ['0', '0.00'],
    ['0.5', '0.50'],
    ['25', '25.00'],
    ['25.00', '25.00'],
    ['1000.10', '1000.10'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('parses %p with a fixed scale of 2 (%p)', (input, expected) => {
    expect(brl(input).amount).toBe(expected);
  });

  it.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E-2'],
    [''],
    [' '],
    [' 1.00'],
    ['1.005'],
    ['10.123'],
    ['-1.00'],
    ['+1.00'],
    ['01.00'],
    ['.50'],
    ['1.'],
    ['1,00'],
    ['0x10'],
    ['1000000000000000000.00'],
  ])('rejects invalid amount %p', (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  it('rejects non-string amounts', () => {
    const asNumber = { amount: 25 as unknown as string, currency: 'BRL' };
    expect(() => Money.from(asNumber)).toThrow(InvalidMoneyError);
  });

  it.each([['brl'], ['BR'], ['BRLL'], ['']])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  it('is exact where floating point is not (0.10 + 0.20)', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
  });

  it('keeps precision beyond Number.MAX_SAFE_INTEGER', () => {
    const big = brl('900719925474099.99');
    expect(big.add(brl('0.01')).amount).toBe('900719925474100.00');
  });

  it('subtracts and may become negative internally', () => {
    const result = brl('10.00').subtract(brl('25.50'));
    expect(result.amount).toBe('-15.50');
    expect(result.isNegative()).toBe(true);
  });

  it('builds values from minor units, including negative totals', () => {
    expect(Money.fromMinorUnits(2550n, 'BRL').amount).toBe('25.50');
    expect(Money.fromMinorUnits(-5n, 'BRL').amount).toBe('-0.05');
  });

  it('negates', () => {
    expect(brl('5.10').negate().amount).toBe('-5.10');
    expect(brl('0').negate().isZero()).toBe(true);
  });

  it('compares values', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
  });

  it('treats equal amounts in different currencies as different', () => {
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  it.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ])('throws a domain error on currency conflict in %s', (_name, operation) => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => operation(brl('1.00'), usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Money immutability and serialization', () => {
  it('returns new instances and never mutates operands', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));

    expect(a.amount).toBe('10.00');
    expect(b).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('serializes to the contract shape', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(JSON.stringify({ money: brl('1.5') })).toBe(
      '{"money":{"amount":"1.50","currency":"BRL"}}',
    );
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});
