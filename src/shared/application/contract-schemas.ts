import { z } from 'zod';

/**
 * Contract shapes shared by HTTP and SQS inputs. Money amounts stay strings
 * here; Money.from performs the exact decimal validation.
 */
export const moneySchema = z.object({
  amount: z.string().min(1).max(32),
  currency: z.string().length(3),
});

export const identifier = z.string().min(1).max(128);
export const uuid = z.uuid();
