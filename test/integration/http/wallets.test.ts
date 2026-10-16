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

const createWallet = (amount = '1000.00', playerId = randomUUID(), currency = 'BRL') =>
  api.post('/wallets', { playerId, initialBalance: { amount, currency } });

describe('POST /wallets', () => {
  it('opens a wallet at version 1 with its balance', async () => {
    const playerId = randomUUID();
    const response = await createWallet('1000.00', playerId);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  it('writes the OPENING transaction, its CREDIT entry and the events atomically', async () => {
    const { body } = await createWallet('250.50');
    const walletId = body.id as string;

    const [opening] = (await sql(
      db,
      `select kind, status, amount from wager_transactions where wallet_id = ?`,
      [walletId],
    )) as { kind: string; status: string; amount: string }[];
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', amount: '250.50' });

    const ledger = await api.get(`/wallets/${walletId}/ledger`);
    expect(ledger.body.items).toMatchObject([
      {
        direction: 'CREDIT',
        balanceBefore: { amount: '0.00' },
        balanceAfter: { amount: '250.50' },
      },
    ]);

    const events = (await sql(
      db,
      `select event_type from outbox_messages where payload->'data'->>'walletId' = ? order by event_type`,
      [walletId],
    )) as { event_type: string }[];
    expect(events.map((e) => e.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('opens an empty wallet without ledger entries', async () => {
    const { body } = await createWallet('0.00');
    const ledger = await api.get(`/wallets/${body.id}/ledger`);
    expect(ledger.body).toEqual({ items: [], nextCursor: null });
  });

  it('refuses a second wallet for the same player and currency', async () => {
    const playerId = randomUUID();
    await createWallet('10.00', playerId);

    const duplicate = await createWallet('10.00', playerId);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      error: { code: 'WALLET_ALREADY_EXISTS', retryable: false },
    });

    const otherCurrency = await createWallet('10.00', playerId, 'USD');
    expect(otherCurrency.status).toBe(201);
  });

  it('serializes concurrent duplicate creations into one wallet', async () => {
    const playerId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createWallet('5.00', playerId)),
    );

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
  });

  it.each([
    [{ amount: '1e3', currency: 'BRL' }],
    [{ amount: '10.001', currency: 'BRL' }],
    [{ amount: '-1.00', currency: 'BRL' }],
    [{ amount: 10, currency: 'BRL' }],
    [{ amount: '10.00', currency: 'brl' }],
  ])('rejects invalid money %p with 400', async (initialBalance) => {
    const response = await api.post('/wallets', { playerId: randomUUID(), initialBalance });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('INVALID_PAYLOAD');
  });
});

describe('GET /wallets', () => {
  it('returns the wallet', async () => {
    const { body } = await createWallet('42.00');
    const response = await api.get(`/wallets/${body.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: body.id, balance: { amount: '42.00' }, version: 1 });
  });

  it('returns 404 for an unknown wallet and 400 for a malformed id', async () => {
    expect((await api.get(`/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await api.get('/wallets/not-a-uuid')).status).toBe(400);
  });

  it('rejects an invalid ledger cursor', async () => {
    const { body } = await createWallet('1.00');
    const response = await api.get(`/wallets/${body.id}/ledger?cursor=garbage`);
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('INVALID_CURSOR');
  });
});
