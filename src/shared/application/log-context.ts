import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Identifiers attached to every log line emitted while a request or message
 * is being handled. Never put money or full payloads here.
 */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Adds identifiers to the current context (no-op outside of one). */
export function bindLogContext(values: LogContext): void {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, values);
  }
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}
