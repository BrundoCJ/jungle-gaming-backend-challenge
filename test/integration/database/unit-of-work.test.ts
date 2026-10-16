import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { openingPayloadHash } from '../../../src/modules/wagering/domain/wager-payload';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/modules/wagering/domain/wager-transaction';
import { WalletBalanceChanged } from '../../../src/modules/wallet/domain/events/wallet-balance-changed';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { MikroOrmUnitOfWork } from '../../../src/platform/database/mikro-orm-unit-of-work';
import {
  type Repositories,
  TransientInfrastructureError,
} from '../../../src/shared/application/unit-of-work';
import { Money } from '../../../src/shared/domain/money';
import { rejectionOf } from '../support/schema-fixtures';
import { createTestDatabase, sql, type TestDatabase } from '../support/test-database';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

let db: TestDatabase;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  db = await createTestDatabase();
  uow = new MikroOrmUnitOfWork(db.orm, { lockTimeoutMs: 200, maxAttempts: 2 });
});

afterAll(async () => {
  await db.dispose();
});

/** Opens a wallet the same way the use case will: wallet + OPENING + ledger + outbox. */
async function openWallet(repos: Repositories, initial: string) {
  const at = new Date();
  const walletId = randomUUID();
  const playerId = randomUUID();
  const openingId = randomUUID();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance: brl(initial),
    at,
    openingTransactionId: openingId,
    openingEntryId: randomUUID(),
  });
  await repos.wallets.insert(wallet);
  if (openingEntry) {
    await repos.transactions.insert(
      WagerTransaction.opening({
        id: openingId,
        walletId,
        playerId,
        money: wallet.balance,
        payloadHash: openingPayloadHash(walletId, playerId, wallet.balance),
        at,
      }),
    );
    await repos.ledger.append(openingEntry);
    await repos.outbox.add([
      OutboxMessage.enqueue(
        WalletBalanceChanged.from(wallet, openingEntry, {
          eventId: randomUUID(),
          correlationId: 'test',
          occurredAt: at,
        }),
      ),
    ]);
  }
  return wallet;
}

function aBet(wallet: Wallet, amount = '25.00') {
  const externalId = `bet-${randomUUID()}`;
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: externalId,
    idempotencyKey: `provider-a:${externalId}`,
    payloadHash: 'c'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl(amount),
    referenceExternalTransactionId: undefined,
    createdAt: new Date(),
  });
}

/** Applies a bet the way the use case will: lock, debit, ledger, conditional update. */
async function applyBet(repos: Repositories, walletId: string, amount: string) {
  const wallet = await repos.wallets.findById(walletId, { forUpdate: true });
  if (!wallet) throw new Error('wallet missing');
  const expectedVersion = wallet.version;
  const bet = aBet(wallet, amount);
  const entry = wallet.debit({
    money: bet.money,
    transactionId: bet.id,
    entryId: randomUUID(),
    at: new Date(),
  });
  bet.markProcessed({
    referenceTransactionId: undefined,
    observedBalance: wallet.balance,
    at: new Date(),
  });
  await repos.transactions.insert(bet);
  await repos.ledger.append(entry);
  await repos.wallets.update(wallet, expectedVersion);
  return bet;
}

describe('MikroOrmUnitOfWork', () => {
  it('commits wallet, transaction, ledger and outbox together', async () => {
    const wallet = await uow.transaction((repos) => openWallet(repos, '1000.00'));

    const stored = await uow.read((repos) => repos.wallets.findById(wallet.id));
    expect(stored?.balance.amount).toBe('1000.00');
    expect(stored?.version).toBe(1);

    const summary = await uow.read((repos) => repos.ledger.summarize(wallet.id, 'BRL'));
    expect(summary).toMatchObject({ entries: 1 });
    expect(summary.net.amount).toBe('1000.00');
  });

  it('rolls everything back when the work fails', async () => {
    let walletId = '';
    expect(
      (
        await rejectionOf(
          uow.transaction(async (repos) => {
            walletId = (await openWallet(repos, '50.00')).id;
            throw new Error('boom');
          }),
        )
      ).message,
    ).toContain('boom');

    expect(await uow.read((repos) => repos.wallets.findById(walletId))).toBeNull();
    const ledger = (await sql(
      db,
      'select count(*)::int as n from wallet_ledger_entries where wallet_id = ?',
      [walletId],
    )) as { n: number }[];
    expect(ledger[0]?.n).toBe(0);
  });

  it('round-trips a processed bet and keeps balance == ledger', async () => {
    const wallet = await uow.transaction((repos) => openWallet(repos, '100.00'));

    const bet = await uow.transaction((repos) => applyBet(repos, wallet.id, '25.00'));

    const stored = await uow.read((repos) =>
      repos.transactions.findByIdempotencyKey(bet.idempotencyKey),
    );
    expect(stored?.status).toBe(WagerTransactionStatus.Processed);
    expect(stored?.observedBalance?.amount).toBe('75.00');
    expect(stored?.money.amount).toBe('25.00');

    const [current, summary] = await uow.read((repos) =>
      Promise.all([repos.wallets.findById(wallet.id), repos.ledger.summarize(wallet.id, 'BRL')]),
    );
    expect(current?.version).toBe(2);
    expect(summary.net.equals(current?.balance ?? brl('0'))).toBe(true);
  });

  it('refuses a balance change without its ledger entry (deferred check)', async () => {
    const wallet = await uow.transaction((repos) => openWallet(repos, '100.00'));

    expect(
      (
        await rejectionOf(
          uow.transaction(async (repos) => {
            const locked = await repos.wallets.findById(wallet.id, { forUpdate: true });
            if (!locked) throw new Error('missing');
            locked.debit({
              money: brl('10.00'),
              transactionId: randomUUID(),
              entryId: randomUUID(),
              at: new Date(),
            });
            await repos.wallets.update(locked, 1); // ledger entry deliberately not written
          }),
        )
      ).message,
    ).toContain('wallets_balance_matches_ledger');

    const stored = await uow.read((repos) => repos.wallets.findById(wallet.id));
    expect(stored?.balance.amount).toBe('100.00');
  });

  it('detects lost updates through the version guard', async () => {
    const wallet = await uow.transaction((repos) => openWallet(repos, '0'));

    expect(
      await rejectionOf(
        uow.transaction(async (repos) => {
          const loaded = await repos.wallets.findById(wallet.id);
          if (!loaded) throw new Error('missing');
          await repos.wallets.update(loaded, 99);
        }),
      ),
    ).toBeInstanceOf(TransientInfrastructureError);
  });

  it('turns lock waits beyond lock_timeout into a transient error', async () => {
    const wallet = await uow.transaction((repos) => openWallet(repos, '10.00'));
    let conflicts = 0;
    const impatient = new MikroOrmUnitOfWork(db.orm, {
      lockTimeoutMs: 100,
      maxAttempts: 1,
      onConflict: () => {
        conflicts += 1;
      },
    });

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockAcquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = uow.transaction(async (repos) => {
      await repos.wallets.findById(wallet.id, { forUpdate: true });
      locked();
      await held;
    });

    await lockAcquired;
    expect(
      await rejectionOf(
        impatient.transaction((repos) => repos.wallets.findById(wallet.id, { forUpdate: true })),
      ),
    ).toBeInstanceOf(TransientInfrastructureError);
    release();
    await holder;
    expect(conflicts).toBe(1);
  });

  it('pages the ledger with a stable cursor', async () => {
    const wallet = await uow.transaction((repos) => openWallet(repos, '100.00'));
    for (const amount of ['1.00', '2.00', '3.00']) {
      await uow.transaction((repos) => applyBet(repos, wallet.id, amount));
    }

    const first = await uow.read((repos) => repos.ledger.page(wallet.id, { limit: 2 }));
    const second = await uow.read((repos) =>
      repos.ledger.page(wallet.id, { afterSequence: first.at(-1)?.sequence, limit: 2 }),
    );

    expect(first.map((item) => item.entry.walletVersion)).toEqual([1, 2]);
    expect(second.map((item) => item.entry.walletVersion)).toEqual([3, 4]);
    expect(second.at(-1)?.entry.balanceAfter.amount).toBe('94.00');
  });
});

describe('outbox claiming', () => {
  it('gives concurrent publishers disjoint rows (FOR UPDATE SKIP LOCKED)', async () => {
    const isolated = await createTestDatabase();
    const work = new MikroOrmUnitOfWork(isolated.orm);
    try {
      for (let i = 0; i < 6; i += 1) {
        await work.transaction((repos) => openWallet(repos, '1.00'));
      }

      let releaseFirst: () => void = () => undefined;
      const firstHolds = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let claimedFirst: (ids: string[]) => void = () => undefined;
      const firstClaim = new Promise<string[]>((resolve) => {
        claimedFirst = resolve;
      });

      const publisherA = work.transaction(async (repos) => {
        const claimed = await repos.outbox.claimDue(new Date(), 4);
        claimedFirst(claimed.map((m) => m.id));
        await firstHolds;
      });
      const idsA = await firstClaim;
      const idsB = await work.transaction(async (repos) =>
        (await repos.outbox.claimDue(new Date(), 4)).map((m) => m.id),
      );
      releaseFirst();
      await publisherA;

      expect(idsA).toHaveLength(4);
      expect(idsB).toHaveLength(2);
      expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    } finally {
      await isolated.dispose();
    }
  });
});
