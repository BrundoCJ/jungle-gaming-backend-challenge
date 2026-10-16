import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { assertLedgerInvariant, countLedgerEntries } from '../integration/support/invariants';
import { startTestApp, type TestApp } from '../integration/support/test-app';
import { createTestDatabase, type TestDatabase } from '../integration/support/test-database';
import { betPayload, openWallet, submitWithRetry, type WalletRef } from './support/provider-client';

let db: TestDatabase;
let app: TestApp;
const urls = () => [app.baseUrl];

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db);
});

afterAll(async () => {
  await app.close();
  await db.dispose();
});

async function balanceOf(wallet: WalletRef): Promise<string> {
  const response = await fetch(`${app.baseUrl}/wallets/${wallet.id}`);
  return ((await response.json()) as { balance: { amount: string } }).balance.amount;
}

describe('contention on a single hot wallet', () => {
  it('60 concurrent 1.00 bets on 30.00: exactly 30 debits, never negative', async () => {
    const wallet = await openWallet(app.baseUrl, '30.00');

    const responses = await Promise.all(
      Array.from({ length: 60 }, () => submitWithRetry(urls, betPayload(wallet, '1.00'))),
    );

    const statuses = responses.map((r) => r.body.status);
    expect(statuses.filter((s) => s === 'PROCESSED')).toHaveLength(30);
    expect(statuses.filter((s) => s === 'REJECTED')).toHaveLength(30);
    expect(responses.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(30);
    expect(await balanceOf(wallet)).toBe('0.00');
    expect(await countLedgerEntries(db, wallet.id, 'DEBIT')).toBe(30);
    await assertLedgerInvariant(db, wallet.id);
  }, 60_000);
});

describe('distinct wallets', () => {
  it('are processed in parallel and each ends with its exact balance', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => openWallet(app.baseUrl, '100.00')),
    );

    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 10 }, () => submitWithRetry(urls, betPayload(wallet, '3.00'))),
      ),
    );

    for (const wallet of wallets) {
      expect(await balanceOf(wallet)).toBe('70.00');
      await assertLedgerInvariant(db, wallet.id);
    }
  }, 60_000);

  it('are not blocked by a lock held on another wallet (no global lock)', async () => {
    const [busy, free] = await Promise.all([
      openWallet(app.baseUrl, '10.00'),
      openWallet(app.baseUrl, '10.00'),
    ]);

    let release: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.orm.em.fork().transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [busy?.id]);
      locked();
      await holding;
    });
    await lockTaken;

    const started = Date.now();
    const freeResponse = await submitWithRetry(urls, betPayload(free as WalletRef, '1.00'));
    const freeElapsed = Date.now() - started;
    const busyPending = submitWithRetry(urls, betPayload(busy as WalletRef, '1.00'));
    await Bun.sleep(300);
    release();
    await holder;
    const busyResponse = await busyPending;

    expect(freeResponse.status).toBe(201);
    expect(freeElapsed).toBeLessThan(1_000);
    expect(busyResponse.status).toBe(201);
  }, 30_000);
});
