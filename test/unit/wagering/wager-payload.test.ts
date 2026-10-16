import { describe, expect, it } from 'bun:test';
import {
  type WagerPayload,
  wagerPayloadHash,
} from '../../../src/modules/wagering/domain/wager-payload';
import { canonicalJson } from '../../../src/shared/domain/canonical-json';
import { InvalidMoneyError } from '../../../src/shared/domain/domain-error';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: 'x' }, z: undefined })).toBe(
      '{"a":{"c":"x","d":true},"b":1}',
    );
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: [2, { q: 1, p: 2 }] })).toBe(
      canonicalJson({ y: [2, { p: 2, q: 1 }], x: 1 }),
    );
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('rejects values JSON cannot represent exactly', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
  });
});

describe('wagerPayloadHash', () => {
  it('is a stable sha256 hex digest', () => {
    const hash = wagerPayloadHash(payload);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(wagerPayloadHash({ ...payload })).toBe(hash);
  });

  it('ignores key order and transport fields such as the idempotency key', () => {
    const reversedKeys = Object.fromEntries(Object.entries(payload).reverse());
    const reordered = {
      idempotencyKey: 'provider-a:transaction-123',
      ...reversedKeys,
      money: { currency: 'BRL', amount: '25.00' },
    } as unknown as WagerPayload;

    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(payload));
  });

  it('normalizes the amount scale', () => {
    expect(wagerPayloadHash({ ...payload, money: { amount: '25', currency: 'BRL' } })).toBe(
      wagerPayloadHash(payload),
    );
  });

  it.each<[string, Partial<WagerPayload>]>([
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['round', { roundId: 'round-988' }],
    ['reference', { referenceExternalTransactionId: 'transaction-100' }],
  ])('changes when the %s changes', (_field, change) => {
    expect(wagerPayloadHash({ ...payload, ...change })).not.toBe(wagerPayloadHash(payload));
  });

  it('rejects invalid money before hashing', () => {
    expect(() =>
      wagerPayloadHash({ ...payload, money: { amount: '1e3', currency: 'BRL' } }),
    ).toThrow(InvalidMoneyError);
  });
});
