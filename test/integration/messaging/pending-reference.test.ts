import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PendingReferenceWorker } from '../../../src/modules/wagering/workers/pending-reference-worker';
import { assertLedgerInvariant } from '../support/invariants';
import { apiClient, startTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, sql, type TestDatabase } from '../support/test-database';

let db: TestDatabase;
let app: TestApp;
let api: ReturnType<typeof apiClient>;
let worker: PendingReferenceWorker;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db);
  api = apiClient(app.baseUrl);
  worker = app.app.get(PendingReferenceWorker);
});

afterAll(async () => {
  await app.close();
  await db.dispose();
});

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallet(amount = '100.00'): Promise<Wallet> {
  const playerId = randomUUID();
  const { body } = await api.post('/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  return { id: body.id as string, playerId };
}

function submit(wallet: Wallet, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  const externalTransactionId = (extra.externalTransactionId as string) ?? `tx-${randomUUID()}`;
  return api.post(
    '/wagering/transactions',
    {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...extra,
    },
    { 'Idempotency-Key': `provider-a:${externalTransactionId}` },
  );
}

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

async function statusOf(transactionId: unknown) {
  return (await api.get(`/wagering/transactions/${transactionId}`)).body as Record<string, unknown>;
}

describe('pending reference worker', () => {
  it('settles a REFUND once its BET arrives (out-of-order delivery)', async () => {
    const wallet = await openWallet('100.00');
    const betId = `bet-${randomUUID()}`;

    const refund = await submit(wallet, 'REFUND', '30.00', {
      referenceExternalTransactionId: betId,
    });
    expect(refund.status).toBe(202);

    await submit(wallet, 'BET', '30.00', { externalTransactionId: betId });
    await worker.runOnce(minutesFromNow(1));

    expect(await statusOf(refund.body.transactionId)).toMatchObject({ status: 'PROCESSED' });
    const balance = (await api.get(`/wallets/${wallet.id}`)).body.balance as { amount: string };
    expect(balance.amount).toBe('100.00');
    await assertLedgerInvariant(db, wallet.id);
  });

  it('settles a ROLLBACK that arrived before the WIN it reverses', async () => {
    const wallet = await openWallet('10.00');
    const winId = `win-${randomUUID()}`;
    const rollback = await submit(wallet, 'ROLLBACK', '50.00', {
      referenceExternalTransactionId: winId,
    });

    await submit(wallet, 'WIN', '50.00', { externalTransactionId: winId });
    await worker.runOnce(minutesFromNow(1));

    expect(await statusOf(rollback.body.transactionId)).toMatchObject({ status: 'PROCESSED' });
    await assertLedgerInvariant(db, wallet.id);
  });

  it('does nothing before the next check is due', async () => {
    const wallet = await openWallet('100.00');
    const betId = `bet-${randomUUID()}`;
    const refund = await submit(wallet, 'REFUND', '5.00', {
      referenceExternalTransactionId: betId,
    });
    await submit(wallet, 'BET', '5.00', { externalTransactionId: betId });

    await worker.runOnce(new Date(Date.now() - 60_000));

    expect(await statusOf(refund.body.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
    });
  });

  it('rejects with REFERENCE_NOT_FOUND after the retry budget and publishes the event', async () => {
    const wallet = await openWallet('100.00');
    const refund = await submit(wallet, 'REFUND', '5.00', {
      referenceExternalTransactionId: 'never-arrives',
    });

    for (let check = 1; check <= 10; check += 1) {
      await worker.runOnce(minutesFromNow(check * 10));
    }

    expect(await statusOf(refund.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
    });
    const events = (await sql(
      db,
      'select event_type from outbox_messages where aggregate_id = ? order by occurred_at',
      [refund.body.transactionId],
    )) as { event_type: string }[];
    expect(events.map((e) => e.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });

  it('is safe with concurrent workers', async () => {
    const wallet = await openWallet('100.00');
    const betId = `bet-${randomUUID()}`;
    const refund = await submit(wallet, 'REFUND', '20.00', {
      referenceExternalTransactionId: betId,
    });
    await submit(wallet, 'BET', '20.00', { externalTransactionId: betId });

    const later = minutesFromNow(1);
    await Promise.all([worker.runOnce(later), worker.runOnce(later), worker.runOnce(later)]);

    expect(await statusOf(refund.body.transactionId)).toMatchObject({ status: 'PROCESSED' });
    const credits = (await sql(
      db,
      `select count(*)::int as n from wallet_ledger_entries where transaction_id = ?`,
      [refund.body.transactionId],
    )) as { n: number }[];
    expect(credits[0]?.n).toBe(1);
    await assertLedgerInvariant(db, wallet.id);
  });
});
