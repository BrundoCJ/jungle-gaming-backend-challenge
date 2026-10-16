import type { z } from 'zod';
import { InvalidRequestError } from '../../shared/application/errors';

/** Parses untrusted input with a Zod schema; failures become 400 INVALID_PAYLOAD. */
export function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new InvalidRequestError(
      'INVALID_PAYLOAD',
      'Request payload is invalid',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
