import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from '../config/app-config';
import { currentLogContext } from './log-context';

export const ROOT_LOGGER = Symbol('ROOT_LOGGER');

// Financial values and raw payloads must never reach the logs.
const REDACTED_PATHS = [
  'money',
  '*.money',
  'amount',
  '*.amount',
  'balance',
  '*.balance',
  'payload',
  '*.payload',
  'headers.authorization',
  '*.headers.authorization',
];

export function createRootLogger(
  config: Pick<AppConfig, 'logLevel' | 'instanceId'>,
  destination?: DestinationStream,
): Logger {
  const options: pino.LoggerOptions = {
    level: config.logLevel,
    messageKey: 'message',
    base: { service: 'wagering-processor', instanceId: config.instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ ...currentLogContext() }),
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  };
  return destination ? pino(options, destination) : pino(options);
}
