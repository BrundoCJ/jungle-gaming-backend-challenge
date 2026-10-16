import { CurrencyMismatchError, InvalidMoneyError } from './domain-error';

/** Contract shape: amount is always a decimal string, e.g. "25.00". */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const MINOR_UNITS_PER_UNIT = 100n;

// Non-negative, no leading zeros, at most 18 integer digits (fits numeric(20,2)),
// at most 2 decimals. Rejects NaN, Infinity, exponents, signs and blanks by construction.
const CONTRACT_AMOUNT = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const ISO_4217 = /^[A-Z]{3}$/;

/**
 * Immutable monetary value with a fixed scale of 2, stored as an integer
 * number of minor units (bigint). No floating point is ever involved.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parses a contract value (non-negative decimal string, up to 2 decimals). */
  static from(props: MoneyProps): Money {
    Money.assertCurrency(props.currency);

    const amount: unknown = props.amount;
    if (typeof amount !== 'string' || !CONTRACT_AMOUNT.test(amount)) {
      throw new InvalidMoneyError(
        `amount must be a non-negative decimal string with up to ${SCALE} decimals, got ${JSON.stringify(amount)}`,
      );
    }

    const [units = '0', fraction = ''] = amount.split('.');
    const minorUnits = BigInt(units) * MINOR_UNITS_PER_UNIT + BigInt(fraction.padEnd(SCALE, '0'));
    return new Money(minorUnits, props.currency);
  }

  /** Builds a (possibly negative) value from integer minor units, e.g. computed totals. */
  static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  /** Decimal string with exactly 2 decimals, e.g. "25.00" or "-5.10". */
  get amount(): string {
    const sign = this.minorUnits < 0n ? '-' : '';
    const absolute = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const units = absolute / MINOR_UNITS_PER_UNIT;
    const fraction = (absolute % MINOR_UNITS_PER_UNIT).toString().padStart(SCALE, '0');
    return `${sign}${units}.${fraction}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): void {
    if (typeof currency !== 'string' || !ISO_4217.test(currency)) {
      throw new InvalidMoneyError(
        `currency must be an ISO-4217 code, got ${JSON.stringify(currency)}`,
      );
    }
  }
}
