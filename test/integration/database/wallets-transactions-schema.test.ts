import { afterAll, beforeAll, describe, it } from 'bun:test';
import { expectViolation, insertRow, transactionRow, walletRow } from '../support/schema-fixtures';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.dispose();
});

async function aWallet(overrides = {}) {
  const row = walletRow(overrides);
  await insertRow(db, 'wallets', row);
  return { id: row.id as string, playerId: row.player_id as string };
}

describe('wallets constraints', () => {
  it('accepts a valid wallet', async () => {
    await aWallet();
  });

  it('refuses a negative balance', async () => {
    await expectViolation(aWallet({ balance: '-0.01' }), 'wallets_balance_non_negative');
  });

  it('allows at most one wallet per player and currency', async () => {
    const { playerId } = await aWallet();
    await expectViolation(aWallet({ player_id: playerId }), 'wallets_player_currency_unique');
    await aWallet({ player_id: playerId, currency: 'USD' });
  });

  it('refuses invalid currency codes and versions below 1', async () => {
    await expectViolation(aWallet({ currency: 'brl' }), 'wallets_currency_iso4217');
    await expectViolation(aWallet({ version: 0 }), 'wallets_version_positive');
  });

  it('stores money exactly with two decimals', async () => {
    await expectViolation(aWallet({ balance: '1000000000000000000.00' }), 'numeric field overflow');
  });
});

describe('wager_transactions constraints', () => {
  let wallet: { id: string; playerId: string };
  const insertTx = (overrides = {}) =>
    insertRow(db, 'wager_transactions', transactionRow(wallet.id, wallet.playerId, overrides));

  beforeAll(async () => {
    wallet = await aWallet();
  });

  it('accepts a processed BET', async () => {
    await insertTx();
  });

  it('enforces unique idempotency keys per provider', async () => {
    await insertTx({ idempotency_key: 'dup-key' });
    await expectViolation(
      insertTx({ idempotency_key: 'dup-key' }),
      'wager_transactions_provider_idempotency_key_unique',
    );
    await insertTx({ idempotency_key: 'dup-key', provider_id: 'provider-b' });
  });

  it('enforces unique (provider_id, external_transaction_id)', async () => {
    await insertTx({ external_transaction_id: 'same-ext' });
    await expectViolation(
      insertTx({ external_transaction_id: 'same-ext' }),
      'wager_transactions_provider_external_unique',
    );
    await insertTx({ external_transaction_id: 'same-ext', provider_id: 'provider-b' });
  });

  it('requires an existing wallet', async () => {
    await expectViolation(
      insertRow(db, 'wager_transactions', transactionRow(crypto.randomUUID(), wallet.playerId)),
      'wager_transactions_wallet_id_fkey',
    );
  });

  it('rejects unknown kinds and statuses', async () => {
    await expectViolation(insertTx({ kind: 'JACKPOT' }), 'wager_transactions_kind_valid');
    await expectViolation(insertTx({ status: 'DONE' }), 'wager_transactions_status_valid');
  });

  it('only LOSS may carry a zero amount', async () => {
    await expectViolation(insertTx({ amount: '0.00' }), 'wager_transactions_amount_valid');
    await insertTx({ kind: 'LOSS', amount: '0.00' });
  });

  it('requires a reference for REFUND and ROLLBACK, and forbids one for BET', async () => {
    await expectViolation(
      insertTx({ kind: 'REFUND' }),
      'wager_transactions_reversal_requires_reference',
    );
    await expectViolation(
      insertTx({ kind: 'ROLLBACK' }),
      'wager_transactions_reversal_requires_reference',
    );
    await expectViolation(
      insertTx({ reference_external_transaction_id: 'x' }),
      'wager_transactions_no_reference_for_bet',
    );
  });

  it('ties failure codes, timestamps and balances to the status', async () => {
    await expectViolation(
      insertTx({ status: 'REJECTED' }),
      'wager_transactions_failure_code_matches_status',
    );
    await expectViolation(
      insertTx({ failure_code: 'INSUFFICIENT_FUNDS' }),
      'wager_transactions_failure_code_matches_status',
    );
    await expectViolation(
      insertTx({ processed_at: null }),
      'wager_transactions_terminal_has_processed_at',
    );
    await expectViolation(
      insertTx({ observed_balance: null }),
      'wager_transactions_processed_has_balance',
    );
    await expectViolation(
      insertTx({
        status: 'PENDING_REFERENCE',
        processed_at: null,
        kind: 'REFUND',
        reference_external_transaction_id: 'r',
      }),
      'wager_transactions_pending_reference_scheduled',
    );
  });

  describe('single reversal', () => {
    it('lets a transaction be reversed by at most one PROCESSED REFUND/ROLLBACK', async () => {
      const bet = transactionRow(wallet.id, wallet.playerId);
      await insertRow(db, 'wager_transactions', bet);
      const reversal = (kind: string, status = 'PROCESSED') => ({
        kind,
        status,
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
        ...(status === 'REJECTED' ? { failure_code: 'AMOUNT_MISMATCH' } : {}),
      });

      await insertTx(reversal('REFUND'));
      await expectViolation(insertTx(reversal('ROLLBACK')), 'wager_transactions_single_reversal');
      await expectViolation(insertTx(reversal('REFUND')), 'wager_transactions_single_reversal');
      // Rejected attempts and WIN/LOSS references do not count as reversals.
      await insertTx(reversal('REFUND', 'REJECTED'));
      await insertTx(reversal('WIN'));
    });
  });
});
