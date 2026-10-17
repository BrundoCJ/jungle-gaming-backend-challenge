import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ProcessWagerTransactionUseCase } from '../../../src/modules/wagering/application/process-wager-transaction';
import {
  type ConsumerHooks,
  WagerMessageConsumer,
} from '../../../src/modules/wagering/messaging/wager-message-consumer';
import { APP_CONFIG, type AppConfig } from '../../../src/platform/config/app-config';
import { QueueDirectory } from '../../../src/platform/messaging/sqs';
import { TransientInfrastructureError } from '../../../src/shared/application/unit-of-work';
import { assertLedgerInvariant, countLedgerEntries } from '../support/invariants';
import { apiClient, startTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, sql, type TestDatabase } from '../support/test-database';
import { createTestQueues, drainQueue, sendFifo, type TestQueues } from '../support/test-queues';

let db: TestDatabase;
let queues: TestQueues;
let app: TestApp;
let api: ReturnType<typeof apiClient>;
let consumer: WagerMessageConsumer;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues({ maxReceiveCount: 3 });
  app = await startTestApp(db, { ...queues.env, SQS_VISIBILITY_TIMEOUT_SECONDS: '2' });
  api = apiClient(app.baseUrl);
  consumer = app.app.get(WagerMessageConsumer);
});

afterAll(async () => {
  await app.close();
  await queues.dispose();
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

function envelope(
  wallet: Wallet,
  data: Record<string, unknown> = {},
  messageId = `msg-${randomUUID()}`,
) {
  const externalTransactionId = (data.externalTransactionId as string) ?? `tx-${randomUUID()}`;
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...data,
    },
  };
}

const send = (body: unknown, groupId: string) =>
  sendFifo(
    queues.client,
    queues.wagerQueueUrl,
    typeof body === 'string' ? body : JSON.stringify(body),
    groupId,
  );

const balanceOf = async (wallet: Wallet) =>
  ((await api.get(`/wallets/${wallet.id}`)).body.balance as { amount: string }).amount;

const inboxCount = async (messageId: string) =>
  (
    (await sql(db, 'select count(*)::int as n from inbox_messages where message_id = ?', [
      messageId,
    ])) as {
      n: number;
    }[]
  )[0]?.n;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function consumerWith(hooks: ConsumerHooks, useCase?: unknown) {
  return new WagerMessageConsumer(
    (useCase ?? app.app.get(ProcessWagerTransactionUseCase)) as ProcessWagerTransactionUseCase,
    app.app.get(SQSClient),
    app.app.get(QueueDirectory),
    app.app.get<AppConfig>(APP_CONFIG),
    hooks,
  );
}

describe('wager message consumer', () => {
  it('applies a message and acks it after the commit, recording it in the inbox', async () => {
    const wallet = await openWallet();
    const message = envelope(wallet);
    await send(message, wallet.id);

    expect(await consumer.pollOnce()).toBe(1);

    expect(await balanceOf(wallet)).toBe('75.00');
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(await drainQueue(queues.client, queues.wagerQueueUrl)).toHaveLength(0);
    await assertLedgerInvariant(db, wallet.id);
  });

  it('absorbs redeliveries of the same message without duplicating effects', async () => {
    const wallet = await openWallet();
    const message = envelope(wallet);
    await send(message, wallet.id);
    await send(message, wallet.id); // new SQS dedup id, same messageId

    await consumer.pollOnce();
    await consumer.pollOnce();

    expect(await countLedgerEntries(db, wallet.id, 'DEBIT')).toBe(1);
    expect(await inboxCount(message.messageId)).toBe(1);
    await assertLedgerInvariant(db, wallet.id);
  });

  it('shares idempotency with HTTP: a transaction sent through both is applied once', async () => {
    const wallet = await openWallet();
    const message = envelope(wallet);
    const { idempotencyKey, ...payload } = message.data;
    await api.post('/wagering/transactions', payload, { 'Idempotency-Key': idempotencyKey });

    await send(message, wallet.id);
    await consumer.pollOnce();

    expect(await countLedgerEntries(db, wallet.id, 'DEBIT')).toBe(1);
    expect(await balanceOf(wallet)).toBe('75.00');
  });

  it('acks business rejections instead of retrying them', async () => {
    const ghost = { id: randomUUID(), playerId: randomUUID() };
    await send(envelope(ghost), ghost.id);

    expect(await consumer.pollOnce()).toBe(1);

    expect(await drainQueue(queues.client, queues.wagerQueueUrl)).toHaveLength(0);
    expect(await drainQueue(queues.client, queues.dlqUrl)).toHaveLength(0);
  });

  it('dead-letters malformed messages and reused messageIds immediately', async () => {
    const wallet = await openWallet();
    const original = envelope(wallet);
    await send(original, wallet.id);
    await consumer.pollOnce();

    await send('{not json', wallet.id);
    await send(
      { ...original, data: { ...original.data, money: { amount: '99.00', currency: 'BRL' } } },
      wallet.id,
    );
    await consumer.pollOnce();
    await consumer.pollOnce();

    const dead = await drainQueue(queues.client, queues.dlqUrl);
    expect(dead.map((m) => m.MessageAttributes?.failureReason?.StringValue).sort()).toEqual([
      'MALFORMED_JSON',
      'MESSAGE_ID_REUSED',
    ]);
    expect(await balanceOf(wallet)).toBe('75.00');
  });

  it('treats a resend with a new occurredAt as the same message, not a poison message', async () => {
    const wallet = await openWallet();
    const message = envelope(wallet);
    await send(message, wallet.id);
    await consumer.pollOnce();

    await send({ ...message, occurredAt: new Date(Date.now() + 60_000).toISOString() }, wallet.id);
    await consumer.pollOnce();

    expect(await countLedgerEntries(db, wallet.id, 'DEBIT')).toBe(1);
    expect(await drainQueue(queues.client, queues.dlqUrl)).toHaveLength(0);
  });

  it('applies only one of two concurrent bodies sharing a messageId', async () => {
    const [first, second] = [await openWallet(), await openWallet()];
    const messageId = `msg-${randomUUID()}`;
    const useCase = app.app.get(ProcessWagerTransactionUseCase);
    const execute = (wallet: Wallet) => {
      const { data } = envelope(wallet, {}, messageId);
      const { idempotencyKey, ...payload } = data;
      return useCase.execute({
        payload: payload as never,
        idempotencyKey,
        source: {
          channel: 'sqs',
          consumerName: 'race-test',
          messageId,
          messageHash: data.walletId,
        },
      });
    };

    const results = await Promise.allSettled([execute(first), execute(second)]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as { code: string }).code).toBe('MESSAGE_ID_REUSED');
    const debits =
      (await countLedgerEntries(db, first.id, 'DEBIT')) +
      (await countLedgerEntries(db, second.id, 'DEBIT'));
    expect(debits).toBe(1);
  });

  it('survives a crash after the commit and before the ack (redelivery is a replay)', async () => {
    const wallet = await openWallet();
    const message = envelope(wallet);
    let crashes = 0;
    const crashing = consumerWith({
      beforeAck: async () => {
        if (crashes === 0) {
          crashes += 1;
          throw new Error('process died before ack');
        }
      },
    });
    await send(message, wallet.id);

    await crashing.pollOnce().catch(() => undefined);
    expect(await countLedgerEntries(db, wallet.id, 'DEBIT')).toBe(1); // committed, not acked

    await sleep(2_500); // visibility timeout expires -> redelivered
    expect(await crashing.pollOnce()).toBe(1);

    expect(await countLedgerEntries(db, wallet.id, 'DEBIT')).toBe(1);
    expect(await drainQueue(queues.client, queues.wagerQueueUrl)).toHaveLength(0);
    await assertLedgerInvariant(db, wallet.id);
  });

  it('retries transient failures with backoff and lets the redrive policy dead-letter them', async () => {
    const wallet = await openWallet();
    const dispositions: string[] = [];
    const flaky = consumerWith(
      { disposition: (d) => dispositions.push(d) },
      { execute: async () => Promise.reject(new TransientInfrastructureError('db down')) },
    );
    flaky.setRetryBackoff({ baseSeconds: 0, maxSeconds: 0 });
    await send(envelope(wallet), wallet.id);

    for (let i = 0; i < 4; i += 1) {
      await flaky.pollOnce();
    }

    expect(dispositions).toEqual(['retry', 'retry', 'retry']);
    expect(await drainQueue(queues.client, queues.dlqUrl)).toHaveLength(1);
    expect(await balanceOf(wallet)).toBe('100.00');
  });

  it('stops promptly on shutdown, interrupting the long poll', async () => {
    const idle = consumerWith({});
    idle.start();
    await sleep(200);

    const started = Date.now();
    await idle.stop();

    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
