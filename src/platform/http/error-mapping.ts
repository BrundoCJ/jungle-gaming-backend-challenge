import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  UnprocessableError,
} from '../../shared/application/errors';
import { TransientInfrastructureError } from '../../shared/application/unit-of-work';
import { DomainError } from '../../shared/domain/domain-error';
import { AppLogger } from '../logging/app-logger';

export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean; details?: unknown };
}

interface MappedError {
  status: number;
  body: ErrorBody;
}

/**
 * One mapping for every endpoint, so providers can decide from the status
 * alone whether to resend:
 *   400 invalid payload / header   -> fix the request
 *   404 unknown resource
 *   409 conflict (idempotency key reused with another payload, duplicates)
 *   422 business rejection          -> do not resend as-is
 *   503 transient infrastructure    -> retry later with the same key
 */
export function mapError(error: unknown): MappedError {
  const body = (code: string, message: string, retryable: boolean, details?: unknown) => ({
    error: { code, message, retryable, ...(details === undefined ? {} : { details }) },
  });

  if (error instanceof InvalidRequestError) {
    return { status: 400, body: body(error.code, error.message, false, error.details) };
  }
  if (error instanceof DomainError) {
    return { status: 400, body: body('INVALID_PAYLOAD', error.message, false) };
  }
  if (error instanceof NotFoundError) {
    return { status: 404, body: body(error.code, error.message, false) };
  }
  if (error instanceof ConflictError) {
    return { status: 409, body: body(error.code, error.message, false) };
  }
  if (error instanceof UnprocessableError) {
    return { status: 422, body: body(error.code, error.message, false) };
  }
  if (error instanceof TransientInfrastructureError) {
    return { status: 503, body: body('SERVICE_UNAVAILABLE', error.message, true) };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === HttpStatus.NOT_FOUND ? 'ROUTE_NOT_FOUND' : 'INVALID_REQUEST';
    return { status, body: body(code, error.message, status >= 500) };
  }
  return { status: 500, body: body('INTERNAL_ERROR', 'Unexpected error', true) };
}

@Catch()
export class ErrorMappingFilter implements ExceptionFilter {
  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = mapError(error);

    if (status >= 500) {
      this.logger.error(error instanceof Error ? error : String(error), 'ErrorMappingFilter');
    }
    if (status === 503) {
      response.setHeader('Retry-After', '1');
    }
    response.status(status).json(body);
  }
}
