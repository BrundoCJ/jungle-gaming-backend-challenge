import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from './root-logger';

/** Adapts pino to Nest's LoggerService so framework logs are JSON too. */
@Injectable()
export class AppLogger implements LoggerService {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    params: unknown[],
  ): void {
    // Nest passes the context name as the last string param, and a stack trace
    // before it for errors.
    const context = typeof params.at(-1) === 'string' ? (params.at(-1) as string) : undefined;
    const stack = level === 'error' && typeof params[0] === 'string' ? params[0] : undefined;

    if (message instanceof Error) {
      this.logger[level]({ context, err: message }, message.message);
      return;
    }
    this.logger[level]({ context, stack }, String(message));
  }
}
