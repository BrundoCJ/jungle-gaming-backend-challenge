import type { EventContext } from '../domain/integration-event';
import type { IdGenerator } from './clock';
import { currentLogContext } from './log-context';

/**
 * Builds the identifiers for an integration event raised now. The
 * correlation id comes from the request/message being handled.
 */
export function newEventContext(
  ids: IdGenerator,
  occurredAt: Date,
  causationId?: string,
): EventContext {
  return {
    eventId: ids.next(),
    correlationId: currentLogContext().correlationId ?? ids.next(),
    causationId,
    occurredAt,
  };
}
