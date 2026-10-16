import { ConcurrentUpdateError } from '../../shared/application/unit-of-work';

/** SQLSTATEs worth retrying the whole transaction for. */
const RETRYABLE = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '23505', // unique_violation: a concurrent insert won; re-reading resolves it
]);

/** SQLSTATEs (or Node error codes) that mean "infrastructure unavailable right now". */
const TRANSIENT = new Set([
  '40001',
  '40P01',
  '55P03',
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000',
  '08001',
  '08003',
  '08006',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

export function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isRetryableDatabaseError(error: unknown): boolean {
  if (error instanceof ConcurrentUpdateError) {
    return true;
  }
  const code = errorCode(error);
  return code !== undefined && RETRYABLE.has(code);
}

export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof ConcurrentUpdateError) {
    return true;
  }
  const code = errorCode(error);
  return code !== undefined && TRANSIENT.has(code);
}

/** Lock contention specifically (feeds the lock-conflict metric). */
export function isLockConflict(error: unknown): boolean {
  if (error instanceof ConcurrentUpdateError) {
    return true;
  }
  const code = errorCode(error);
  return code === '55P03' || code === '40P01' || code === '40001';
}
