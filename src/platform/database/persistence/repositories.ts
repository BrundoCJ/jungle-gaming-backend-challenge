import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import type {
  InboxRepository,
  OutboxRepository,
} from '../../../modules/messaging/application/ports';
import type { InboxMessage } from '../../../modules/messaging/domain/inbox-message';
import type { OutboxMessage } from '../../../modules/messaging/domain/outbox-message';
import type {
  PendingReferenceCandidate,
  WagerTransactionRepository,
} from '../../../modules/wagering/application/ports';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../modules/wagering/domain/wager-transaction';
import type {
  LedgerPageItem,
  LedgerRepository,
  LedgerSummary,
  WalletRepository,
} from '../../../modules/wallet/application/ports';
import type { Wallet } from '../../../modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../../modules/wallet/domain/wallet-ledger-entry';
import { ConcurrentUpdateError, type Repositories } from '../../../shared/application/unit-of-work';
import { Money } from '../../../shared/domain/money';
import {
  fromInbox,
  fromLedgerEntry,
  fromOutbox,
  fromTransaction,
  fromWallet,
  toInbox,
  toLedgerEntry,
  toOutbox,
  toTransaction,
  toWallet,
  transactionChanges,
} from './mappers';
import {
  InboxSchema,
  LedgerEntrySchema,
  OutboxSchema,
  WagerTransactionSchema,
  WalletSchema,
} from './schemas';

/*
 * Repositories use explicit native operations (insert / conditional
 * nativeUpdate / locking reads) instead of change tracking, so every
 * financial write maps to one predictable SQL statement.
 */

// Reads bypass the identity map so a row is never served stale inside a transaction.
const FRESH = { disableIdentityMap: true } as const;

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<Wallet | null> {
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      options.forUpdate ? { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE } : FRESH,
    );
    return record ? toWallet(record) : null;
  }

  async findByPlayer(playerId: string, currency: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletSchema, { playerId, currency }, FRESH);
    return record ? toWallet(record) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, fromWallet(wallet));
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (updated !== 1) {
      throw new ConcurrentUpdateError('Wallet', wallet.id);
    }
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, fromLedgerEntry(entry));
  }

  async page(
    walletId: string,
    options: { afterSequence?: string; limit: number },
  ): Promise<LedgerPageItem[]> {
    const records = await this.em.find(
      LedgerEntrySchema,
      options.afterSequence ? { walletId, sequence: { $gt: options.afterSequence } } : { walletId },
      { ...FRESH, orderBy: { sequence: 'asc' }, limit: options.limit },
    );
    return records.map((record) => ({
      entry: toLedgerEntry(record),
      sequence: String(record.sequence),
    }));
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = (await this.em.execute(
      `SELECT count(*)::int AS entries,
              (coalesce(sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) * 100)::bigint::text AS net_minor
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    )) as { entries: number; net_minor: string }[];
    return {
      entries: row?.entries ?? 0,
      net: Money.fromMinorUnits(BigInt(row?.net_minor ?? '0'), currency),
    };
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionSchema, { id }, FRESH);
    return record ? toTransaction(record) : null;
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { providerId, idempotencyKey },
      FRESH,
    );
    return record ? toTransaction(record) : null;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { providerId, externalTransactionId },
      FRESH,
    );
    return record ? toTransaction(record) : null;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, fromTransaction(transaction));
  }

  async update(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      transactionChanges(transaction),
    );
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]> {
    const records = await this.em.find(
      WagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference, nextReferenceCheckAt: { $lte: now } },
      { ...FRESH, orderBy: { nextReferenceCheckAt: 'asc' }, limit },
    );
    return records.map((record) => ({ id: record.id, walletId: record.walletId }));
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const record = await this.em.findOne(InboxSchema, { consumerName, messageId }, FRESH);
    return record ? toInbox(record) : null;
  }

  async insert(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxSchema, fromInbox(message));
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: OutboxMessage[]): Promise<void> {
    if (messages.length > 0) {
      await this.em.insertMany(OutboxSchema, messages.map(fromOutbox));
    }
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxSchema,
      { publishedAt: null, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      {
        ...FRESH,
        orderBy: { occurredAt: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return records.map(toOutbox);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxSchema,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      },
    );
  }

  async oldestPendingOccurredAt(): Promise<Date | null> {
    const [record] = await this.em.find(
      OutboxSchema,
      { publishedAt: null },
      { ...FRESH, orderBy: { occurredAt: 'asc' }, limit: 1, fields: ['occurredAt'] },
    );
    return record?.occurredAt ?? null;
  }
}

export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
