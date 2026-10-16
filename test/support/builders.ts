import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/modules/wagering/domain/wager-transaction';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import { Money } from '../../src/shared/domain/money';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export const T0 = new Date('2026-01-01T00:00:00.000Z');
export const T1 = new Date('2026-01-01T00:01:00.000Z');

export function aWallet(initial = '100.00', overrides: { id?: string; playerId?: string } = {}) {
  return Wallet.open({
    id: overrides.id ?? 'wallet-1',
    playerId: overrides.playerId ?? 'player-1',
    initialBalance: brl(initial),
    at: T0,
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
  }).wallet;
}

let sequence = 0;

export function aTransaction(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  sequence += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${sequence}`;
  return WagerTransaction.create({
    id: `tx-${sequence}`,
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: `hash-${sequence}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    createdAt: T0,
    ...overrides,
  });
}

/** A transaction already applied, usable as a reference. */
export function aProcessed(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const transaction = aTransaction(kind, overrides);
  transaction.markProcessed({
    referenceTransactionId: undefined,
    observedBalance: brl('0'),
    at: T0,
  });
  return transaction;
}

export const Kind = WagerTransactionKind;
