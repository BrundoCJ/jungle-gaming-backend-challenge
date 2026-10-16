import {
  addMilliseconds,
  type BackoffPolicy,
  backoffDelayMs,
} from '../../../shared/domain/backoff';
import { InvalidMessageStateError } from '../../../shared/domain/domain-error';
import type { IntegrationEvent } from '../../../shared/domain/integration-event';

/** 1s, 2s, 4s ... capped at 60s. Confirmed events are never dropped. */
export const OUTBOX_RETRY_POLICY: BackoffPolicy = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

/**
 * Integration event waiting to be published. Written in the same SQL
 * transaction as the change that raised it; a worker publishes it later.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** The outbox id is the eventId, so consumers can deduplicate by it. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze({ ...event.toJSON() }),
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`outbox message ${this.id} was already published`);
    }
    this._publishedAt = at;
  }

  /** Increments attempts and computes the next attempt time (exponential backoff). */
  scheduleRetry(now: Date, policy: BackoffPolicy = OUTBOX_RETRY_POLICY): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`outbox message ${this.id} was already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = addMilliseconds(now, backoffDelayMs(this._attempts, policy));
  }
}
