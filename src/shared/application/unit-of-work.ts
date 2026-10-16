import type { InboxRepository, OutboxRepository } from '../../modules/messaging/application/ports';
import type { WagerTransactionRepository } from '../../modules/wagering/application/ports';
import type { LedgerRepository, WalletRepository } from '../../modules/wallet/application/ports';

/** Repositories bound to one database transaction. */
export interface Repositories {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Port for atomic work. Everything done through the given repositories is
 * committed together or not at all. `work` may run more than once when the
 * database reports a transient conflict, so it must not have side effects
 * outside the repositories.
 */
export abstract class UnitOfWork {
  abstract transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
  /** Read-only access without an explicit transaction. */
  abstract read<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

/** Infrastructure is temporarily unavailable or contended; the caller may retry later. */
export class TransientInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientInfrastructureError';
  }
}

/** A conditional update found a different version than expected (lost-update guard). */
export class ConcurrentUpdateError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was modified concurrently`);
    this.name = 'ConcurrentUpdateError';
  }
}
