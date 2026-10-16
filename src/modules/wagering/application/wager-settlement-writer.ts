import type { IdGenerator } from '../../../shared/application/clock';
import { newEventContext } from '../../../shared/application/event-context';
import type { Repositories } from '../../../shared/application/unit-of-work';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-transaction-events';
import { type Settlement, settleWager } from '../domain/wager-settlement';
import {
  type ReferenceRetryPolicy,
  type WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager-transaction';

export interface SettleOptions {
  /** New transactions are inserted; parked ones (PENDING_REFERENCE) are updated. */
  isNew: boolean;
  at: Date;
  causationId?: string;
  retryPolicy?: ReferenceRetryPolicy;
}

/**
 * Resolves the reference, applies the domain decision and writes every
 * resulting row (transaction, ledger entry, wallet, outbox) through the
 * caller's transaction. The wallet must already be locked by the caller.
 * Shared by the HTTP/SQS use case and the pending-reference worker.
 */
export async function settleAndPersist(
  repos: Repositories,
  ids: IdGenerator,
  transaction: WagerTransaction,
  wallet: Wallet,
  options: SettleOptions,
): Promise<Settlement> {
  const reference = transaction.referenceExternalTransactionId
    ? ((await repos.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      )) ?? undefined)
    : undefined;
  const referenceAlreadyReversed =
    reference !== undefined && transaction.requiresReference()
      ? await repos.transactions.hasProcessedReversal(reference.id)
      : false;

  const expectedVersion = wallet.version;
  const wasPending = transaction.status === WagerTransactionStatus.PendingReference;
  const settlement = settleWager(
    { transaction, wallet, reference, referenceAlreadyReversed },
    { entryId: ids.next(), at: options.at, retryPolicy: options.retryPolicy },
  );

  // Order matters for foreign keys: transaction, then ledger entry, then wallet.
  if (options.isNew) {
    await repos.transactions.insert(transaction);
  } else {
    await repos.transactions.update(transaction);
  }
  if (settlement.entry) {
    await repos.ledger.append(settlement.entry);
    await repos.wallets.update(wallet, expectedVersion);
  }
  await repos.outbox.add(
    eventsFor(transaction, wallet, settlement.entry, ids, options, {
      announcePending: !wasPending,
    }),
  );
  return settlement;
}

function eventsFor(
  transaction: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  ids: IdGenerator,
  options: SettleOptions,
  flags: { announcePending: boolean },
): OutboxMessage[] {
  const ctx = () => newEventContext(ids, options.at, options.causationId);
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      return [
        OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, ctx())),
        ...(entry ? [OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx()))] : []),
      ];
    case WagerTransactionStatus.Rejected:
      return [OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, ctx()))];
    case WagerTransactionStatus.PendingReference:
      return flags.announcePending
        ? [OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, ctx()))]
        : [];
    default:
      return [];
  }
}
