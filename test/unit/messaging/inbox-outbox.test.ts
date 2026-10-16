import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../../src/modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../../src/modules/wallet/domain/events/wallet-balance-changed';
import { backoffDelayMs } from '../../../src/shared/domain/backoff';
import { InvalidMessageStateError } from '../../../src/shared/domain/domain-error';
import { aWallet, brl, T0, T1 } from '../../support/builders';

const at = (seconds: number) => new Date(T0.getTime() + seconds * 1_000);

function anEvent() {
  const wallet = aWallet('100.00');
  const entry = wallet.debit({ money: brl('10.00'), transactionId: 'tx', entryId: 'e', at: T0 });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: 'evt-1',
    correlationId: 'corr',
    occurredAt: T0,
  });
}

describe('InboxMessage', () => {
  const props = {
    messageId: 'msg-1',
    consumerName: 'wager-consumer',
    payloadHash: 'h1',
    receivedAt: T0,
  };

  it('starts unprocessed and is marked once', () => {
    const inbox = InboxMessage.receive(props);
    expect(inbox.isProcessed()).toBe(false);

    inbox.markProcessed(T1);

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(T1);
    expect(() => inbox.markProcessed(T1)).toThrow(InvalidMessageStateError);
  });

  it('detects a different body under the same messageId', () => {
    const inbox = InboxMessage.receive(props);
    expect(inbox.matchesPayload('h1')).toBe(true);
    expect(inbox.matchesPayload('h2')).toBe(false);
  });

  it('requires identifiers', () => {
    expect(() => InboxMessage.receive({ ...props, messageId: '' })).toThrow(
      InvalidMessageStateError,
    );
  });
});

describe('OutboxMessage', () => {
  it('enqueues the serialized envelope under the event id', () => {
    const event = anEvent();
    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe('evt-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual({ ...event.toJSON() });
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(T0)).toBe(true);
  });

  it('backs off exponentially between failed attempts', () => {
    const message = OutboxMessage.enqueue(anEvent());

    message.scheduleRetry(T0);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(at(1));
    expect(message.isDue(at(0.5))).toBe(false);
    expect(message.isDue(at(1))).toBe(true);

    message.scheduleRetry(T0);
    message.scheduleRetry(T0);
    expect(message.nextAttemptAt).toEqual(at(4));
  });

  it('caps the backoff', () => {
    expect(backoffDelayMs(30, { baseDelayMs: 1_000, maxDelayMs: 60_000 })).toBe(60_000);
  });

  it('is published exactly once from its own point of view', () => {
    const message = OutboxMessage.enqueue(anEvent());

    message.markPublished(T1);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(999))).toBe(false);
    expect(() => message.markPublished(T1)).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(T1)).toThrow(InvalidMessageStateError);
  });
});
