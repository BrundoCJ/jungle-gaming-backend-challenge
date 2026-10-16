export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Exponential backoff: base * 2^(attempt-1), capped. `attempt` starts at 1. */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
}

export function addMilliseconds(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
