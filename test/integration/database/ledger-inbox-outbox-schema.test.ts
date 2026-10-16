import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { expectViolation, insertRow, transactionRow, walletRow } from '../support/schema-fixtures';
import { createTestDatabase, sql, type TestDatabase } from '../support/test-database';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.dispose();
});

/** Empty wallet plus one BET transaction to hang ledger entries on. */
async function walletWithTransaction() {
  const wallet = walletRow();
  await insertRow(db, 'wallets', wallet);
  const tx = transactionRow(wallet.id as string, wallet.player_id as string, { kind: 'WIN' });
  await insertRow(db, 'wager_transactions', tx);
  return { walletId: wallet.id as string, transactionId: tx.id as string };
}

function entryRow(walletId: string, transactionId: string, overrides = {}) {
  return {
    id: randomUUID(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: 'CREDIT',
    amount: '25.00',
    currency: 'BRL',
    balance_before: '0.00',
    balance_after: '25.00',
    wallet_version: 2,
    created_at: new Date(),
    ...overrides,
  };
}

/** Runs statements in one transaction (deferred constraints fire on commit). */
function inTransaction(statements: [string, unknown[]][]) {
  return db.orm.em.fork().transactional(async (em) => {
    for (const [query, params] of statements) {
      await em.execute(query, params);
    }
  });
}

describe('wallet_ledger_entries', () => {
  it('accepts a balanced entry and assigns an increasing sequence', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    await insertRow(db, 'wallet_ledger_entries', entryRow(walletId, transactionId));

    const rows = (await sql(db, 'select sequence from wallet_ledger_entries where wallet_id = ?', [
      walletId,
    ])) as { sequence: unknown }[];
    expect(Number(rows[0]?.sequence)).toBeGreaterThan(0);
  });

  it('refuses unbalanced arithmetic and non-positive amounts', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    await expectViolation(
      insertRow(
        db,
        'wallet_ledger_entries',
        entryRow(walletId, transactionId, { balance_after: '30.00' }),
      ),
      'wallet_ledger_entries_balanced',
    );
    await expectViolation(
      insertRow(
        db,
        'wallet_ledger_entries',
        entryRow(walletId, transactionId, {
          direction: 'DEBIT',
          balance_before: '10.00',
          balance_after: '-15.00',
        }),
      ),
      'wallet_ledger_entries_balances_non_negative',
    );
    await expectViolation(
      insertRow(
        db,
        'wallet_ledger_entries',
        entryRow(walletId, transactionId, { amount: '0.00', balance_after: '0.00' }),
      ),
      'wallet_ledger_entries_amount_positive',
    );
  });

  it('allows one entry per transaction and one per wallet version', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    await insertRow(db, 'wallet_ledger_entries', entryRow(walletId, transactionId));
    await expectViolation(
      insertRow(
        db,
        'wallet_ledger_entries',
        entryRow(walletId, transactionId, { wallet_version: 3 }),
      ),
      'wallet_ledger_entries_one_per_transaction',
    );

    const other = await walletWithTransaction();
    const otherTx = transactionRow(other.walletId, randomUUID(), { kind: 'WIN' });
    await insertRow(db, 'wager_transactions', otherTx);
    await insertRow(db, 'wallet_ledger_entries', entryRow(other.walletId, other.transactionId));
    await expectViolation(
      insertRow(db, 'wallet_ledger_entries', entryRow(other.walletId, otherTx.id as string)),
      'wallet_ledger_entries_wallet_version_unique',
    );
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    await insertRow(db, 'wallet_ledger_entries', entryRow(walletId, transactionId));

    await expectViolation(
      sql(db, `update wallet_ledger_entries set amount = 1 where wallet_id = ?`, [walletId]),
      'append-only',
    );
    await expectViolation(
      sql(db, 'delete from wallet_ledger_entries where wallet_id = ?', [walletId]),
      'append-only',
    );
    await expectViolation(sql(db, 'truncate wallet_ledger_entries cascade'), 'append-only');
  });
});

describe('wallet balance vs ledger (deferred check)', () => {
  it('refuses a balance change without its ledger entry at commit', async () => {
    const { walletId } = await walletWithTransaction();

    await expectViolation(
      inTransaction([[`update wallets set balance = 50, version = 2 where id = ?`, [walletId]]]),
      'wallets_balance_matches_ledger',
    );
    const rows = (await sql(db, 'select balance from wallets where id = ?', [walletId])) as {
      balance: string;
    }[];
    expect(rows[0]?.balance).toBe('0.00');
  });

  it('accepts the change when the matching entry is written in the same transaction', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    const entry = entryRow(walletId, transactionId);
    const columns = Object.keys(entry);

    await inTransaction([
      [`update wallets set balance = 25, version = 2 where id = ?`, [walletId]],
      [
        `insert into wallet_ledger_entries (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
        Object.values(entry),
      ],
    ]);
  });

  it('refuses a new wallet with a balance but no opening entry', async () => {
    await expectViolation(
      insertRow(db, 'wallets', walletRow({ balance: '10.00' })),
      'wallets_balance_matches_ledger',
    );
  });
});

describe('inbox and outbox', () => {
  it('deduplicates inbox messages per (consumer_name, message_id)', async () => {
    const row = {
      consumer_name: 'wager-consumer',
      message_id: 'msg-1',
      payload_hash: 'b'.repeat(64),
      received_at: new Date(),
      processed_at: new Date(),
    };
    await insertRow(db, 'inbox_messages', row);
    await expectViolation(insertRow(db, 'inbox_messages', row), 'inbox_messages_pkey');
    await insertRow(db, 'inbox_messages', { ...row, consumer_name: 'other-consumer' });
  });

  it('stores outbox payloads as jsonb', async () => {
    const id = randomUUID();
    await insertRow(db, 'outbox_messages', {
      id,
      aggregate_id: 'wallet-1',
      event_type: 'WalletBalanceChanged',
      payload: JSON.stringify({ eventId: id, data: { amount: '1.00' } }),
      occurred_at: new Date(),
    });
    const rows = (await sql(
      db,
      `select payload->'data'->>'amount' as amount from outbox_messages where id = ?`,
      [id],
    )) as { amount: string }[];
    expect(rows[0]?.amount).toBe('1.00');
  });
});
