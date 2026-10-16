import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { assertLedgerInvariant, countLedgerEntries } from '../integration/support/invariants';
import { createTestDatabase, sql, type TestDatabase } from '../integration/support/test-database';
import {
  createTestQueues,
  drainQueue,
  sendFifo,
  type TestQueues,
} from '../integration/support/test-queues';
import { type AppProcess, spawnApp } from './support/app-process';
import {
  betPayload,
  eventually,
  openWallet,
  submitWithRetry,
  type WalletRef,
} from './support/provider-client';

const WALLETS = 5;
const BETS_PER_WALLET = 20;
const BET_AMOUNT = '2.00';

let db: TestDatabase;
let queues: TestQueues;
let env: Record<string, string>;
let instances: AppProcess[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues({ maxReceiveCount: 5 });
  env = {
    DATABASE_URL: db.url,
    ...queues.env,
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '200',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
  };
  instances = await Promise.all([spawnApp(env, 'p1'), spawnApp(env, 'p2'), spawnApp(env, 'p3')]);
}, 90_000);

afterAll(async () => {
  await Promise.all(instances.map((instance) => instance.kill()));
  await queues.dispose();
  await db.dispose();
});

const liveUrls = () => instances.map((instance) => instance.baseUrl);

const count = async (query: string, params: unknown[] = []) =>
  ((await sql(db, query, params)) as { n: number }[])[0]?.n ?? 0;

function envelope(payload: ReturnType<typeof betPayload>) {
  return JSON.stringify({
    messageId: `msg-${payload.externalTransactionId}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...payload, idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}` },
  });
}

describe('three application instances', () => {
  it('stay correct with duplicates over HTTP and SQS while one instance crashes and restarts', async () => {
    const wallets: WalletRef[] = [];
    for (let i = 0; i < WALLETS; i += 1) {
      wallets.push(await openWallet(liveUrls()[i % 3] as string, '1000.00'));
    }
    const bets = wallets.flatMap((wallet) =>
      Array.from({ length: BETS_PER_WALLET }, () => betPayload(wallet, BET_AMOUNT)),
    );

    // Every bet: twice over HTTP (different instances) and twice over SQS.
    const dispatch = (from: number, to: number) =>
      bets
        .slice(from, to)
        .flatMap((bet, index) => [
          submitWithRetry(liveUrls, bet, index),
          submitWithRetry(liveUrls, bet, index + 1),
          sendFifo(queues.client, queues.wagerQueueUrl, envelope(bet), bet.walletId),
          sendFifo(queues.client, queues.wagerQueueUrl, envelope(bet), bet.walletId),
        ]);

    const firstHalf = Promise.all(dispatch(0, bets.length / 2));
    // Crash one instance while the first half is in flight, then bring it back.
    await Bun.sleep(150);
    const crashed = instances[2] as AppProcess;
    await crashed.kill();
    instances = instances.slice(0, 2);
    await firstHalf;
    instances.push(await spawnApp(env, 'p3-restarted', crashed.port));
    await Promise.all(dispatch(bets.length / 2, bets.length));

    await eventually(
      async () =>
        (await count(
          `select count(*)::int as n from wager_transactions where kind = 'BET' and status = 'PROCESSED'`,
        )) === bets.length,
      60_000,
      'all bets processed',
    );
    await eventually(
      async () =>
        (await count(
          'select count(*)::int as n from outbox_messages where published_at is null',
        )) === 0,
      60_000,
      'outbox drained by the publishers',
    );

    for (const wallet of wallets) {
      expect(await countLedgerEntries(db, wallet.id, 'DEBIT')).toBe(BETS_PER_WALLET);
      await assertLedgerInvariant(db, wallet.id);
      const reconciliation = await fetch(`${liveUrls()[0]}/wallets/${wallet.id}/reconciliation`, {
        method: 'POST',
      });
      expect(await reconciliation.json()).toMatchObject({
        consistent: true,
        storedBalance: { amount: '960.00' },
      });
    }

    // Every committed event reached the broker at least once.
    const events = await drainQueue(queues.client, queues.eventsQueueUrl);
    const eventIds = new Set(
      events.map((m) => (JSON.parse(m.Body as string) as { eventId: string }).eventId),
    );
    expect(eventIds.size).toBe(await count('select count(*)::int as n from outbox_messages'));
  }, 180_000);

  it('keep processing on the surviving instances after a crash (restart recovery)', async () => {
    const wallet = await openWallet(liveUrls()[0] as string, '50.00');
    const victim = instances[0] as AppProcess;
    await victim.kill();
    instances = instances.slice(1);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        submitWithRetry(liveUrls, betPayload(wallet, '5.00'), i),
      ),
    );
    instances.push(await spawnApp(env, 'p1-restarted', victim.port));

    expect(responses.every((r) => r.status === 201)).toBe(true);
    await assertLedgerInvariant(db, wallet.id);
    const balance = await fetch(`${liveUrls().at(-1)}/wallets/${wallet.id}`);
    expect(((await balance.json()) as { balance: { amount: string } }).balance.amount).toBe('0.00');
  }, 90_000);
});
