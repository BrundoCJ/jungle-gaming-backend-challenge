import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithLogContext } from './log-context';

export const CORRELATION_HEADER = 'x-correlation-id';

const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Reuses a well-formed incoming correlation id or creates a new one. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const correlationId = incoming && VALID_CORRELATION_ID.test(incoming) ? incoming : randomUUID();

  res.setHeader(CORRELATION_HEADER, correlationId);
  runWithLogContext({ correlationId }, next);
}
