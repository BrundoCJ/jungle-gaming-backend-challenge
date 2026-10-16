import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EventPublisher } from '../../../src/modules/messaging/application/event-publisher';
import { OutboxPublisher } from '../../../src/modules/messaging/application/outbox-publisher';
import { SystemClock } from '../../../src/shared/application/clock';
import { UnitOfWork } from '../../../src/shared/application/unit-of-work';
import { apiClient, startTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, sql, type TestDatabase } from '../support/test-database';
import { createTestQueues, drainQueue, type TestQueues } from '../support/test-queues';

let db: TestDatabase;
let queues: TestQueues;
let instanceA: TestApp;
let instanceB: TestApp;

const WORKERS_OFF = {
  RUN_SQS_CONSUMER: 'false',
  RUN_OUTBOX_PUBLISHER: 'false',
  RUN_PENDING_REFERENCE_WORKER: 'false',
};

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues();
  instanceA = await startTestApp(db, { ...queues.env, ...WORKERS_OFF, INSTANCE_ID: 'a' });
  instanceB = await startTestApp(db, { ...queues.env, ...WORKERS_OFF, INSTANCE_ID: 'b' });
});

afterAll(async () => {
  await instanceA.close();
  await instanceB.close();
  await queues.dispose();
  await db.dispose();
});

const pendingCount = async () =>
  (
    (await sql(
      db,
      'select count(*)::int as n from outbox_messages where published_at is null',
    )) as {
      n: number;
    }[]
  )[0]?.n ?? 0;

describe('outbox publisher', () => {
  it('two concurrent publishers deliver every event, each row published once', async () => {
    const api = apiClient(instanceA.baseUrl);
    for (let i = 0; i < 15; i += 1) {
      await api.post('/wallets', {
        playerId: randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });
    }
    const total = 30; // two events per opened wallet
    expect(await pendingCount()).toBe(total);

    const publisherA = instanceA.app.get(OutboxPublisher);
    const publisherB = instanceB.app.get(OutboxPublisher);
    const reports = [];
    while ((await pendingCount()) > 0) {
      reports.push(
        ...(await Promise.all([publisherA.publishPending(4), publisherB.publishPending(4)])),
      );
    }

    const published = reports.reduce((sum, report) => sum + report.published, 0);
    expect(published).toBe(total);
    const rows = (await sql(
      db,
      'select count(*)::int as n from outbox_messages where published_at is not null and attempts = 0',
    )) as { n: number }[];
    expect(rows[0]?.n).toBe(total);

    const delivered = await drainQueue(queues.client, queues.eventsQueueUrl);
    const eventIds = delivered.map(
      (m) => (JSON.parse(m.Body as string) as { eventId: string }).eventId,
    );
    expect(new Set(eventIds).size).toBe(total);
    expect(delivered[0]?.MessageAttributes?.eventType?.StringValue).toBeDefined();
  });

  it('keeps failed messages pending and schedules a retry with backoff', async () => {
    await apiClient(instanceA.baseUrl).post('/wallets', {
      playerId: randomUUID(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    class BrokenBroker extends EventPublisher {
      async publish(): Promise<void> {
        throw new Error('broker down');
      }
    }
    const failing = new OutboxPublisher(
      instanceA.app.get(UnitOfWork),
      new BrokenBroker(),
      new SystemClock(),
    );

    const report = await failing.publishPending();

    expect(report).toMatchObject({ claimed: 2, published: 0, failed: 2 });
    const rows = (await sql(
      db,
      `select attempts, next_attempt_at > now() as later from outbox_messages where published_at is null`,
    )) as { attempts: number; later: boolean }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.attempts === 1 && row.later)).toBe(true);

    // Not due yet: a healthy publisher leaves them alone until the backoff expires.
    expect((await instanceB.app.get(OutboxPublisher).publishPending()).claimed).toBe(0);
  });
});
