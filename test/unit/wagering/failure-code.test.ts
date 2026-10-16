import { describe, expect, it } from 'bun:test';
import { FAILURE_CODES, FailureCode } from '../../../src/modules/wagering/domain/failure-code';
import {
  DomainError,
  InsufficientFundsError,
  InvalidTransactionStateError,
} from '../../../src/shared/domain/domain-error';

describe('FailureCode taxonomy', () => {
  const codes = Object.values(FailureCode);

  it('documents every code with a provider action', () => {
    for (const code of codes) {
      expect(FAILURE_CODES[code].description.length).toBeGreaterThan(0);
      expect(FAILURE_CODES[code].providerAction).toBeDefined();
    }
  });

  it('uses unique SCREAMING_SNAKE_CASE values', () => {
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });

  it('distinguishes an overdrawing reversal from an unfunded bet', () => {
    expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
    expect(FAILURE_CODES[FailureCode.ReversalWouldOverdraw].providerAction).not.toBe(
      FAILURE_CODES[FailureCode.InsufficientFunds].providerAction,
    );
  });
});

describe('DomainError', () => {
  it('exposes a stable code and the concrete class name', () => {
    const error = new InsufficientFundsError('wallet-1');

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('INSUFFICIENT_FUNDS');
    expect(error.name).toBe('InsufficientFundsError');
  });

  it('describes invalid state transitions', () => {
    const error = new InvalidTransactionStateError('tx-1', 'PROCESSED', 'REJECTED');
    expect(error.message).toContain('PROCESSED');
    expect(error.code).toBe('INVALID_TRANSACTION_STATE');
  });
});
