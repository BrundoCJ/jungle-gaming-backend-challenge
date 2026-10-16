import type { OutboxMessage } from '../domain/outbox-message';

/** Port to the message broker for integration events. */
export abstract class EventPublisher {
  abstract publish(message: OutboxMessage): Promise<void>;
}
