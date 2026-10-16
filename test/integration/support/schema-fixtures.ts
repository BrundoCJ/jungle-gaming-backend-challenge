import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql, type TestDatabase } from './test-database';

type Row = Record<string, unknown>;

/** Inserts a row built from `values`, letting tests override any column. */
export async function insertRow(db: TestDatabase, table: string, values: Row): Promise<void> {
  const columns = Object.keys(values);
  const placeholders = columns.map(() => '?').join(', ');
  await sql(
    db,
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    Object.values(values),
  );
}

export function walletRow(overrides: Row = {}): Row {
  const now = new Date();
  return {
    id: randomUUID(),
    player_id: randomUUID(),
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function transactionRow(walletId: string, playerId: string, overrides: Row = {}): Row {
  const externalId = `ext-${randomUUID()}`;
  return {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: walletId,
    player_id: playerId,
    round_id: 'round-1',
    game_id: 'fortune-chimp',
    kind: 'BET',
    amount: '25.00',
    currency: 'BRL',
    status: 'PROCESSED',
    observed_balance: '75.00',
    created_at: new Date(),
    processed_at: new Date(),
    ...overrides,
  };
}

/** Asserts the statement is refused by the database because of `constraint`. */
export async function expectViolation(statement: Promise<unknown>, constraint: string) {
  let error: unknown;
  try {
    await statement;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  expect(String((error as Error).message)).toContain(constraint);
}

/**
 * Awaits a promise that must reject and returns the error. Used instead of
 * `expect(promise).rejects`, which can hang under bun test after a driver error.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}
