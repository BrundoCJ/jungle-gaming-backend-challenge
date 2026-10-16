import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/domain/canonical-json';
import { Money, type MoneyProps } from '../../../shared/domain/money';

/** Business fields of a wager request, as received over HTTP or SQS. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * payloadHash = hex(sha256(canonicalJson(business fields))).
 *
 * Only the fields listed here take part, so the Idempotency-Key header,
 * the SQS envelope and any transport metadata never change the hash.
 * The amount is normalized to scale 2 first ("25.5" and "25.50" are the
 * same payload).
 */
export function wagerPayloadHash(payload: WagerPayload): string {
  return sha256Hex(
    canonicalJson({
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: Money.from(payload.money).toJSON(),
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
    }),
  );
}

/** Hash for the internal OPENING transaction of a wallet. */
export function openingPayloadHash(walletId: string, playerId: string, money: Money): string {
  return sha256Hex(canonicalJson({ kind: 'OPENING', walletId, playerId, money: money.toJSON() }));
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
