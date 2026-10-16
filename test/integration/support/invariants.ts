import { expect } from 'bun:test';
import { sql, type TestDatabase } from './test-database';

/**
 * Final invariant of every test: the materialized balance equals the balance
 * rebuilt from the ledger, and equals the balance_after of the last entry.
 */
export async function assertLedgerInvariant(db: TestDatabase, walletId: string): Promise<void> {
  const [row] = (await sql(
    db,
    `SELECT w.balance::text AS balance,
            (SELECT coalesce(sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)
               FROM wallet_ledger_entries e WHERE e.wallet_id = w.id)::numeric(20, 2)::text AS rebuilt,
            coalesce((SELECT e.balance_after FROM wallet_ledger_entries e
                       WHERE e.wallet_id = w.id ORDER BY e.sequence DESC LIMIT 1), 0)::numeric(20, 2)::text AS last_after
       FROM wallets w WHERE w.id = ?`,
    [walletId],
  )) as { balance: string; rebuilt: string; last_after: string }[];

  expect(row).toBeDefined();
  expect(row?.rebuilt).toBe(row?.balance as string);
  expect(row?.last_after).toBe(row?.balance as string);
}

export async function countLedgerEntries(
  db: TestDatabase,
  walletId: string,
  direction?: 'DEBIT' | 'CREDIT',
): Promise<number> {
  const [row] = (await sql(
    db,
    `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? ${direction ? 'AND direction = ?' : ''}`,
    direction ? [walletId, direction] : [walletId],
  )) as { n: number }[];
  return row?.n ?? 0;
}
