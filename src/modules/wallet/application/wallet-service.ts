import { Inject, Injectable } from '@nestjs/common';
import { Clock, IdGenerator } from '../../../shared/application/clock';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
} from '../../../shared/application/errors';
import { newEventContext } from '../../../shared/application/event-context';
import { UnitOfWork } from '../../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WagerTransactionProcessed } from '../../wagering/domain/events/wager-transaction-events';
import { openingPayloadHash } from '../../wagering/domain/wager-payload';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  /** Opaque; pass back as ?cursor= to get the next page. Null on the last page. */
  nextCursor: string | null;
}

export const MAX_LEDGER_PAGE = 200;

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

function toEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

const encodeCursor = (sequence: string) =>
  Buffer.from(JSON.stringify({ s: sequence })).toString('base64url');

function decodeCursor(cursor: string): string {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      s?: unknown;
    };
    if (typeof decoded.s === 'string' && /^\d+$/.test(decoded.s)) {
      return decoded.s;
    }
  } catch {
    // fall through
  }
  throw new InvalidRequestError('INVALID_CURSOR', 'cursor is not valid');
}

@Injectable()
export class WalletService {
  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(Clock) private readonly clock: Clock,
    @Inject(IdGenerator) private readonly ids: IdGenerator,
  ) {}

  /**
   * Opens a wallet. A positive initial balance creates the internal OPENING
   * transaction, its CREDIT ledger entry and the events in the same SQL
   * transaction.
   */
  async create(input: { playerId: string; initialBalance: MoneyProps }): Promise<WalletView> {
    const initialBalance = Money.from(input.initialBalance);

    return this.uow.transaction(async (repos) => {
      if (await repos.wallets.findByPlayer(input.playerId, initialBalance.currency)) {
        throw new ConflictError(
          'WALLET_ALREADY_EXISTS',
          `player already has a ${initialBalance.currency} wallet`,
        );
      }

      const at = this.clock.now();
      const openingTransactionId = this.ids.next();
      const { wallet, openingEntry } = Wallet.open({
        id: this.ids.next(),
        playerId: input.playerId,
        initialBalance,
        at,
        openingTransactionId,
        openingEntryId: this.ids.next(),
      });
      await repos.wallets.insert(wallet);

      if (openingEntry) {
        const opening = WagerTransaction.opening({
          id: openingTransactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initialBalance,
          payloadHash: openingPayloadHash(wallet.id, wallet.playerId, initialBalance),
          at,
        });
        await repos.transactions.insert(opening);
        await repos.ledger.append(openingEntry);
        await repos.outbox.add([
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(opening, newEventContext(this.ids, at)),
          ),
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, openingEntry, newEventContext(this.ids, at)),
          ),
        ]);
      }
      return toWalletView(wallet);
    });
  }

  async get(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.read((repos) => repos.wallets.findById(walletId));
    if (!wallet) {
      throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
    }
    return toWalletView(wallet);
  }

  async ledger(
    walletId: string,
    options: { cursor?: string; limit: number },
  ): Promise<LedgerPageView> {
    const afterSequence = options.cursor ? decodeCursor(options.cursor) : undefined;
    const limit = Math.min(Math.max(options.limit, 1), MAX_LEDGER_PAGE);

    return this.uow.read(async (repos) => {
      if (!(await repos.wallets.findById(walletId))) {
        throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
      }
      // Fetch one extra row to know whether another page exists.
      const page = await repos.ledger.page(walletId, { afterSequence, limit: limit + 1 });
      const items = page.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map((item) => toEntryView(item.entry)),
        nextCursor: page.length > limit && last ? encodeCursor(last.sequence) : null,
      };
    });
  }
}
