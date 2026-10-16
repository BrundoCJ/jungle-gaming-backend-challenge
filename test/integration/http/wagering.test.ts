import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { assertLedgerInvariant, countLedgerEntries } from '../support/invariants';
import { apiClient, startTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, sql, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let app: TestApp;
let api: ReturnType<typeof apiClient>;
const touchedWallets = new Set<string>();

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db);
  api = apiClient(app.baseUrl);
});

afterEach(async () => {
  for (const walletId of touchedWallets) {
    await assertLedgerInvariant(db, walletId);
  }
  touchedWallets.clear();
});

afterAll(async () => {
  await app.close();
  await db.dispose();
});

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallet(amount: string, currency = 'BRL'): Promise<Wallet> {
  const playerId = randomUUID();
  const { body } = await api.post('/wallets', { playerId, initialBalance: { amount, currency } });
  touchedWallets.add(body.id as string);
  return { id: body.id as string, playerId };
}

type Body = Record<string, unknown>;

function request(wallet: Wallet, kind: string, amount: string, extra: Body = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

const submit = (payload: Body, key = `${payload.providerId}:${payload.externalTransactionId}`) =>
  api.post('/wagering/transactions', payload, { 'Idempotency-Key': key });

const balanceOf = async (wallet: Wallet) =>
  ((await api.get(`/wallets/${wallet.id}`)).body.balance as { amount: string }).amount;

describe('POST /wagering/transactions — idempotency', () => {
  it('processes a BET and replays the identical response', async () => {
    const wallet = await openWallet('1000.00');
    const bet = request(wallet, 'BET', '25.00');

    const first = await submit(bet);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    // A later debit changes the balance; the replay still reports the original one.
    await submit(request(wallet, 'BET', '5.00'));
    const replay = await submit(bet);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await countLedgerEntries(db, wallet.id, 'DEBIT')).toBe(2);
  });

  it('treats the same key with a different payload as a conflict, not a replay', async () => {
    const wallet = await openWallet('100.00');
    const bet = request(wallet, 'BET', '10.00');
    await submit(bet);

    const conflict = await submit({ ...bet, money: { amount: '11.00', currency: 'BRL' } });

    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_CONFLICT', retryable: false },
    });
    expect(await balanceOf(wallet)).toBe('90.00');
  });

  it('ignores key order and amount scale when comparing payloads', async () => {
    const wallet = await openWallet('100.00');
    const bet = request(wallet, 'BET', '10.00');
    await submit(bet);

    const replay = await submit({ ...bet, money: { currency: 'BRL', amount: '10' } });
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it('requires the Idempotency-Key header', async () => {
    const wallet = await openWallet('100.00');
    const response = await api.post('/wagering/transactions', request(wallet, 'BET', '1.00'));
    expect(response.status).toBe(400);
    expect((response.body.error as Body).code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('applies 50 parallel copies of the same bet exactly once', async () => {
    const wallet = await openWallet('1000.00');
    const bet = request(wallet, 'BET', '10.00');

    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(bet)));

    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(await countLedgerEntries(db, wallet.id, 'DEBIT')).toBe(1);
    expect(await balanceOf(wallet)).toBe('990.00');
  });
});

describe('POST /wagering/transactions — validation', () => {
  it.each([
    ['OPENING kind', { kind: 'OPENING' }],
    ['scientific notation', { money: { amount: '1e2', currency: 'BRL' } }],
    ['three decimals', { money: { amount: '1.005', currency: 'BRL' } }],
    ['numeric amount', { money: { amount: 10, currency: 'BRL' } }],
    ['REFUND without reference', { kind: 'REFUND' }],
  ])('rejects %s with 400', async (_case, change) => {
    const wallet = await openWallet('100.00');
    const response = await submit({ ...request(wallet, 'BET', '1.00'), ...change });
    expect(response.status).toBe(400);
    expect(await balanceOf(wallet)).toBe('100.00');
  });

  it('rejects an unknown wallet with 422 WALLET_NOT_FOUND', async () => {
    const ghost = { id: randomUUID(), playerId: randomUUID() };
    const response = await submit(request(ghost, 'BET', '1.00'));
    expect(response.status).toBe(422);
    expect((response.body.error as Body).code).toBe('WALLET_NOT_FOUND');
  });
});

describe('business rules', () => {
  it('section 8: 100.00 and two parallel 80.00 bets -> one processed, one rejected', async () => {
    const wallet = await openWallet('100.00');

    const responses = await Promise.all([
      submit(request(wallet, 'BET', '80.00')),
      submit(request(wallet, 'BET', '80.00')),
    ]);

    expect(responses.map((r) => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = responses.find((r) => r.body.status === 'REJECTED');
    expect(rejected?.status).toBe(422);
    expect(rejected?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(wallet)).toBe('20.00');
    expect(await countLedgerEntries(db, wallet.id, 'DEBIT')).toBe(1);
  });

  it('persists a rejection and replays it', async () => {
    const wallet = await openWallet('5.00');
    const bet = request(wallet, 'BET', '10.00');

    const first = await submit(bet);
    const replay = await submit(bet);

    expect(first.status).toBe(422);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: true,
    });
  });

  it('rejects a currency conflict', async () => {
    const wallet = await openWallet('100.00');
    const response = await submit(
      request(wallet, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } }),
    );
    expect(response.body).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH' });
  });

  it('WIN credits and LOSS records without touching the ledger', async () => {
    const wallet = await openWallet('100.00');
    const bet = request(wallet, 'BET', '20.00');
    await submit(bet);

    const win = await submit(
      request(wallet, 'WIN', '50.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    const loss = await submit(request(wallet, 'LOSS', '0.00', { roundId: 'round-2' }));

    expect(win.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '130.00' } });
    expect(loss.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '130.00' } });
    expect(await countLedgerEntries(db, wallet.id)).toBe(3);
  });

  it('REFUND reverses a BET once', async () => {
    const wallet = await openWallet('100.00');
    const bet = request(wallet, 'BET', '30.00');
    await submit(bet);
    const ref = { referenceExternalTransactionId: bet.externalTransactionId };

    const refund = await submit(request(wallet, 'REFUND', '30.00', ref));
    const again = await submit(request(wallet, 'REFUND', '30.00', ref));
    const rollback = await submit(request(wallet, 'ROLLBACK', '30.00', ref));

    expect(refund.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    expect(again.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
    expect(rollback.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
  });

  it('REFUND must match the referenced amount and kind', async () => {
    const wallet = await openWallet('100.00');
    const bet = request(wallet, 'BET', '30.00');
    const win = request(wallet, 'WIN', '5.00');
    await submit(bet);
    await submit(win);

    const partial = await submit(
      request(wallet, 'REFUND', '10.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    const ofWin = await submit(
      request(wallet, 'REFUND', '5.00', {
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );

    expect(partial.body.failureCode).toBe('AMOUNT_MISMATCH');
    expect(ofWin.body.failureCode).toBe('REFERENCE_INVALID_KIND');
  });

  it('ROLLBACK of a WIN that would overdraw is rejected with its own code', async () => {
    const wallet = await openWallet('10.00');
    const win = request(wallet, 'WIN', '50.00');
    await submit(win);
    await submit(request(wallet, 'BET', '55.00'));

    const rollback = await submit(
      request(wallet, 'ROLLBACK', '50.00', {
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );

    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    expect(await balanceOf(wallet)).toBe('5.00');
  });

  it('parks a REFUND that arrives before its BET', async () => {
    const wallet = await openWallet('100.00');

    const refund = await submit(
      request(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: 'bet-not-yet' }),
    );

    expect(refund.status).toBe(202);
    expect(refund.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
    const events = (await sql(db, `select event_type from outbox_messages where aggregate_id = ?`, [
      refund.body.transactionId,
    ])) as { event_type: string }[];
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference']);
  });
});

describe('GET transactions', () => {
  it('finds a transaction by internal id and by provider id', async () => {
    const wallet = await openWallet('100.00');
    const bet = request(wallet, 'BET', '1.00');
    const { body } = await submit(bet);

    const byId = await api.get(`/wagering/transactions/${body.transactionId}`);
    const byExternal = await api.get(
      `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
    );

    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '1.00' },
    });
    expect(byExternal.body).toEqual(byId.body);
    expect((await api.get(`/wagering/transactions/${randomUUID()}`)).status).toBe(404);
  });
});
