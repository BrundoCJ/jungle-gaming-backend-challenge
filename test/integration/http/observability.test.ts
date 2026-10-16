import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { OutboxPublisher } from '../../../src/modules/messaging/application/outbox-publisher';
import { apiClient, startTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';
import { createTestQueues, type TestQueues } from '../support/test-queues';

let db: TestDatabase;
let queues: TestQueues;
let app: TestApp;
let api: ReturnType<typeof apiClient>;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues();
  app = await startTestApp(db, queues.env);
  api = apiClient(app.baseUrl);
});

afterAll(async () => {
  await app.close();
  await queues.dispose();
  await db.dispose();
});

const metricsText = async () => (await fetch(`${app.baseUrl}/metrics`)).text();

describe('health checks', () => {
  it('reports liveness and readiness (PostgreSQL + SQS) without authentication', async () => {
    expect((await api.get('/health/live')).status).toBe(200);

    const ready = await api.get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { database: 'up', sqs: 'up' } });
  });

  it('is not ready when the queue is unreachable', async () => {
    const broken = await startTestApp(db, {
      ...queues.env,
      SQS_WAGER_QUEUE_NAME: 'missing-queue.fifo',
    });
    try {
      const ready = await apiClient(broken.baseUrl).get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({
        status: 'unavailable',
        checks: { database: 'up', sqs: 'down' },
      });
    } finally {
      await broken.close();
    }
  });
});

describe('metrics', () => {
  it('exposes transactions by status, duplicates, latency and outbox lag', async () => {
    const playerId = randomUUID();
    const { body: wallet } = await api.post('/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const bet = {
      providerId: 'provider-a',
      externalTransactionId: `tx-${randomUUID()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const headers = { 'Idempotency-Key': `provider-a:${bet.externalTransactionId}` };
    await api.post('/wagering/transactions', bet, headers);
    await api.post('/wagering/transactions', bet, headers);
    await app.app.get(OutboxPublisher).publishPending();

    const text = await metricsText();

    expect(text).toContain(
      'wager_transactions_total{kind="BET",status="PROCESSED",channel="http"} 1',
    );
    expect(text).toContain('wager_duplicates_total{channel="http",mechanism="idempotency-key"} 1');
    expect(text).toContain('wager_processing_duration_seconds_bucket');
    expect(text).toContain('outbox_messages_total{result="published"}');
    expect(text).toMatch(/outbox_lag_seconds \d/);
    for (const name of [
      'sqs_message_retries_total',
      'sqs_dead_lettered_total',
      'db_lock_conflicts_total',
    ]) {
      expect(text).toContain(`# TYPE ${name} counter`);
    }
  });
});
