import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { apiClient, startTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, sql, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let app: TestApp;
let api: ReturnType<typeof apiClient>;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db);
  api = apiClient(app.baseUrl);
});

afterAll(async () => {
  await app.close();
  await db.dispose();
});

async function walletWithActivity() {
  const playerId = randomUUID();
  const { body } = await api.post('/wallets', {
    playerId,
    initialBalance: { amount: '1000.00', currency: 'BRL' },
  });
  const walletId = body.id as string;
  for (const amount of ['25.00', '0.10']) {
    const externalTransactionId = `bet-${randomUUID()}`;
    await api.post(
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      },
      { 'Idempotency-Key': `provider-a:${externalTransactionId}` },
    );
  }
  return walletId;
}

describe('POST /wallets/:id/reconciliation', () => {
  it('reports a consistent wallet', async () => {
    const walletId = await walletWithActivity();

    const response = await api.post(`/wallets/${walletId}/reconciliation`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId,
      storedBalance: { amount: '974.90', currency: 'BRL' },
      calculatedBalance: { amount: '974.90', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  it('flags a divergence without correcting it', async () => {
    const walletId = await walletWithActivity();
    // Simulate corruption by bypassing the schema guard on purpose.
    await sql(db, 'ALTER TABLE wallets DISABLE TRIGGER wallets_balance_matches_ledger');
    try {
      await sql(db, `UPDATE wallets SET balance = balance + 5 WHERE id = ?`, [walletId]);
    } finally {
      await sql(db, 'ALTER TABLE wallets ENABLE TRIGGER wallets_balance_matches_ledger');
    }

    const response = await api.post(`/wallets/${walletId}/reconciliation`);

    expect(response.body).toMatchObject({
      storedBalance: { amount: '979.90' },
      calculatedBalance: { amount: '974.90' },
      difference: { amount: '5.00' },
      consistent: false,
    });
    const stored = await api.get(`/wallets/${walletId}`);
    expect((stored.body.balance as { amount: string }).amount).toBe('979.90');
  });

  it('returns 404 for an unknown wallet', async () => {
    expect((await api.post(`/wallets/${randomUUID()}/reconciliation`)).status).toBe(404);
  });
});
