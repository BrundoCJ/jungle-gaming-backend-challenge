import { randomUUID } from 'node:crypto';

export interface WalletRef {
  id: string;
  playerId: string;
}

export interface WagerResponse {
  status: number;
  body: Record<string, unknown>;
}

export function betPayload(
  wallet: WalletRef,
  amount: string,
  externalTransactionId = `tx-${randomUUID()}`,
) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${externalTransactionId}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

/**
 * Behaves like a provider: submits with an Idempotency-Key and, on a
 * network error or 503, retries the same request (same key) against the
 * next instance.
 */
export async function submitWithRetry(
  baseUrls: () => string[],
  payload: ReturnType<typeof betPayload>,
  startAt = 0,
  attempts = 8,
): Promise<WagerResponse> {
  const key = `${payload.providerId}:${payload.externalTransactionId}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const urls = baseUrls();
    const baseUrl = urls[(startAt + attempt) % urls.length];
    try {
      const response = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (response.status !== 503) {
        return { status: response.status, body };
      }
      lastError = new Error('503');
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50 * (attempt + 1));
  }
  throw new Error(`gave up after ${attempts} attempts: ${String(lastError)}`);
}

export async function openWallet(baseUrl: string, amount: string): Promise<WalletRef> {
  const playerId = randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  const body = (await response.json()) as { id: string };
  return { id: body.id, playerId };
}

/** Polls `check` until it returns true or the timeout expires. */
export async function eventually(check: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for: ${label}`);
}
