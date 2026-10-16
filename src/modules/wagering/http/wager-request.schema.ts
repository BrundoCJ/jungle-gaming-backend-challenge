import { z } from 'zod';
import { identifier, moneySchema, uuid } from '../../../shared/application/contract-schemas';
import { PROVIDER_KINDS } from '../domain/wager-transaction';

/** Business payload of a wager request; identical over HTTP and SQS. OPENING is not accepted. */
export const wagerRequestSchema = z.object({
  providerId: identifier,
  externalTransactionId: identifier,
  playerId: uuid,
  walletId: uuid,
  roundId: identifier,
  gameId: identifier,
  kind: z.enum(PROVIDER_KINDS),
  money: moneySchema,
  referenceExternalTransactionId: identifier.optional(),
});

export type WagerRequest = z.infer<typeof wagerRequestSchema>;

export const idempotencyKeySchema = z.string().trim().min(1).max(255);
