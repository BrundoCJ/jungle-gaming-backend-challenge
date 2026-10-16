import type { InboxMessage } from '../domain/inbox-message';
import type { OutboxMessage } from '../domain/outbox-message';

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  insert(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(messages: OutboxMessage[]): Promise<void>;
  /**
   * Locks up to `limit` due messages with FOR UPDATE SKIP LOCKED, so concurrent
   * publishers never receive the same row while the lock is held.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  oldestPendingOccurredAt(): Promise<Date | null>;
}
