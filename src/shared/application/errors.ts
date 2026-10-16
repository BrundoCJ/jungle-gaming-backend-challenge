/**
 * Application-level outcomes that are not business rejections of a
 * transaction. Each carries a stable code; the HTTP layer maps the class
 * to a status code.
 */
export abstract class ApplicationError extends Error {
  protected constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed request (schema, missing header, bad cursor). Fix the request. */
export class InvalidRequestError extends ApplicationError {
  constructor(
    code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(code, message);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** The request contradicts existing state (e.g. idempotency key reused with another payload). */
export class ConflictError extends ApplicationError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/**
 * A queue message that can never succeed as sent (e.g. the same messageId
 * redelivered with a different body). Goes straight to the DLQ.
 */
export class PoisonMessageError extends ApplicationError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** Business rule violation that is not persisted (e.g. unknown wallet). */
export class UnprocessableError extends ApplicationError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}
