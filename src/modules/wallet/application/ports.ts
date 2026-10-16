import type { Money } from '../../../shared/domain/money';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** `forUpdate` takes a row lock (SELECT ... FOR UPDATE) until the transaction ends. */
  findById(id: string, options?: { forUpdate?: boolean }): Promise<Wallet | null>;
  findByPlayer(playerId: string, currency: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  /** Conditional update: fails if the stored version is not `expectedVersion`. */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface LedgerPageItem {
  entry: WalletLedgerEntry;
  /** Monotonic position used to build the opaque cursor. */
  sequence: string;
}

export interface LedgerSummary {
  entries: number;
  /** Credits minus debits. */
  net: Money;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(
    walletId: string,
    options: { afterSequence?: string; limit: number },
  ): Promise<LedgerPageItem[]>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}
