import { hostname } from 'node:os';
import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof logLevels)[number];

/** "true"/"false" environment flag; enabled unless explicitly turned off. */
const booleanFlag = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  INSTANCE_ID: z.string().min(1).default(hostname()),
  LOG_LEVEL: z.enum(logLevels).default('info'),

  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .default('postgres://wagering:wagering@localhost:5432/wagering'),

  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  SQS_WAGER_QUEUE_NAME: z.string().endsWith('.fifo').default('wager-transactions.fifo'),
  SQS_WAGER_DLQ_NAME: z.string().endsWith('.fifo').default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_NAME: z.string().endsWith('.fifo').default('wallet-events.fifo'),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(43_200).default(30),

  RUN_SQS_CONSUMER: booleanFlag,
  RUN_OUTBOX_PUBLISHER: booleanFlag,
  RUN_PENDING_REFERENCE_WORKER: booleanFlag,
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(500),
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(1_000),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  instanceId: string;
  logLevel: LogLevel;
  database: { url: string };
  aws: { region: string; endpoint: string | undefined };
  sqs: {
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
  };
  workers: {
    sqsConsumer: boolean;
    outboxPublisher: boolean;
    pendingReference: boolean;
    outboxPollIntervalMs: number;
    pendingReferencePollIntervalMs: number;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export class InvalidConfigError extends Error {
  constructor(details: string) {
    super(`Invalid environment configuration:\n${details}`);
    this.name = 'InvalidConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new InvalidConfigError(z.prettifyError(parsed.error));
  }

  const vars = parsed.data;
  return {
    env: vars.NODE_ENV,
    port: vars.PORT,
    instanceId: vars.INSTANCE_ID,
    logLevel: vars.LOG_LEVEL,
    database: { url: vars.DATABASE_URL },
    aws: { region: vars.AWS_REGION, endpoint: vars.AWS_ENDPOINT_URL },
    sqs: {
      wagerQueueName: vars.SQS_WAGER_QUEUE_NAME,
      wagerDlqName: vars.SQS_WAGER_DLQ_NAME,
      eventsQueueName: vars.SQS_EVENTS_QUEUE_NAME,
      waitTimeSeconds: vars.SQS_WAIT_TIME_SECONDS,
      visibilityTimeoutSeconds: vars.SQS_VISIBILITY_TIMEOUT_SECONDS,
    },
    workers: {
      sqsConsumer: vars.RUN_SQS_CONSUMER,
      outboxPublisher: vars.RUN_OUTBOX_PUBLISHER,
      pendingReference: vars.RUN_PENDING_REFERENCE_WORKER,
      outboxPollIntervalMs: vars.OUTBOX_POLL_INTERVAL_MS,
      pendingReferencePollIntervalMs: vars.PENDING_REFERENCE_POLL_INTERVAL_MS,
    },
  };
}
