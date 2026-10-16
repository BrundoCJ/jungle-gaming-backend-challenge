import { createHash } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../../platform/config/app-config';
import { runWithLogContext } from '../../../platform/logging/log-context';
import { QueueDirectory } from '../../../platform/messaging/sqs';
import { identifier } from '../../../shared/application/contract-schemas';
import {
  ConflictError,
  InvalidRequestError,
  PoisonMessageError,
  UnprocessableError,
} from '../../../shared/application/errors';
import { MetricsRecorder } from '../../../shared/application/metrics';
import { canonicalJson } from '../../../shared/domain/canonical-json';
import { DomainError } from '../../../shared/domain/domain-error';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction';
import { idempotencyKeySchema, wagerRequestSchema } from '../http/wager-request.schema';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

const envelopeSchema = z.object({
  messageId: identifier,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string(),
  data: wagerRequestSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type Disposition = 'acked' | 'retry' | 'dead-lettered';

/** Hooks for observability and fault-injection tests. */
export abstract class ConsumerHooks {
  /** Runs after the business commit and before the ack; throwing simulates a crash there. */
  beforeAck?(messageId: string): Promise<void>;
  disposition?(disposition: Disposition, reason: string): void;
}

export interface RetryBackoff {
  baseSeconds: number;
  maxSeconds: number;
}

/**
 * SQS consumer for wager-transactions.fifo. It reuses the HTTP use case, so
 * the database (inbox + idempotency key + wallet lock) is what guarantees
 * correctness, not the broker. The message is deleted only after the SQL
 * transaction committed.
 *
 *   business outcome / rejection -> ack (terminal for the provider)
 *   transient failure            -> no ack, visibility backoff; after
 *                                   maxReceiveCount the redrive policy moves
 *                                   it to the DLQ
 *   permanent failure            -> sent to the DLQ immediately, then acked
 */
@Injectable()
export class WagerMessageConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WagerMessageConsumer.name);
  private running = false;
  private loop: Promise<void> | undefined;
  private poll: AbortController | undefined;
  private backoff: RetryBackoff = { baseSeconds: 2, maxSeconds: 60 };

  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly useCase: ProcessWagerTransactionUseCase,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(QueueDirectory) private readonly queues: QueueDirectory,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(ConsumerHooks) private readonly hooks?: ConsumerHooks,
    @Optional() @Inject(MetricsRecorder) private readonly metrics?: MetricsRecorder,
  ) {}

  setRetryBackoff(backoff: RetryBackoff): void {
    this.backoff = backoff;
  }

  onApplicationBootstrap(): void {
    if (this.config.workers.sqsConsumer) {
      this.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          await this.pollOnce();
        } catch (error) {
          if (this.running) {
            this.logger.error(`poll failed: ${String(error)}`);
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }
      }
    })();
  }

  /** Stops polling, finishes the message in flight and releases the rest of the batch. */
  async stop(): Promise<void> {
    this.running = false;
    this.poll?.abort();
    await this.loop;
  }

  /** Receives one batch and processes it sequentially. Returns how many messages were handled. */
  async pollOnce(): Promise<number> {
    const queueUrl = await this.queues.url(this.config.sqs.wagerQueueName);
    this.poll = new AbortController();
    let messages: Message[];
    try {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: this.config.sqs.waitTimeSeconds,
          VisibilityTimeout: this.config.sqs.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: this.poll.signal },
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.poll.signal.aborted) {
        return 0;
      }
      throw error;
    }

    let handled = 0;
    for (const message of messages) {
      if (!this.running && this.loop !== undefined) {
        // Shutting down: hand the untouched messages back to the queue right away.
        await this.changeVisibility(queueUrl, message, 0);
        continue;
      }
      await this.handle(queueUrl, message);
      handled += 1;
    }
    return handled;
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    const body = message.Body ?? '';
    const parsed = this.parse(body);
    if (!parsed.ok) {
      await this.deadLetter(queueUrl, message, parsed.reason);
      return;
    }
    const envelope = parsed.envelope;
    const { idempotencyKey, ...payload } = envelope.data;

    await runWithLogContext(
      { correlationId: envelope.messageId, messageId: envelope.messageId },
      async () => {
        try {
          await this.useCase.execute({
            payload,
            idempotencyKey,
            source: {
              channel: 'sqs',
              consumerName: WAGER_CONSUMER_NAME,
              messageId: envelope.messageId,
              messageHash: sha256(canonicalJson(envelope)),
            },
          });
        } catch (error) {
          await this.onFailure(queueUrl, message, error);
          return;
        }
        await this.hooks?.beforeAck?.(envelope.messageId);
        await this.ack(queueUrl, message, 'processed');
      },
    );
  }

  private async onFailure(queueUrl: string, message: Message, error: unknown): Promise<void> {
    if (error instanceof PoisonMessageError) {
      await this.deadLetter(queueUrl, message, error.code);
      return;
    }
    if (
      error instanceof UnprocessableError ||
      error instanceof ConflictError ||
      error instanceof InvalidRequestError ||
      error instanceof DomainError
    ) {
      // Terminal business outcome: retrying the same message cannot change it.
      this.logger.warn(`message rejected: ${(error as { code: string }).code}`);
      await this.ack(queueUrl, message, (error as { code: string }).code);
      return;
    }
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const delay = Math.min(
      this.backoff.baseSeconds * 2 ** Math.max(0, receiveCount - 1),
      this.backoff.maxSeconds,
    );
    this.logger.warn(
      `transient failure (receive ${receiveCount}), retrying in ${delay}s: ${String(error)}`,
    );
    this.hooks?.disposition?.('retry', 'transient');
    this.metrics?.messageDisposition('retry', 'transient');
    await this.changeVisibility(queueUrl, message, delay);
  }

  private parse(
    body: string,
  ): { ok: true; envelope: z.infer<typeof envelopeSchema> } | { ok: false; reason: string } {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'MALFORMED_JSON' };
    }
    const result = envelopeSchema.safeParse(json);
    return result.success
      ? { ok: true, envelope: result.data }
      : { ok: false, reason: 'INVALID_ENVELOPE' };
  }

  private async ack(queueUrl: string, message: Message, reason: string): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
    this.hooks?.disposition?.('acked', reason);
    this.metrics?.messageDisposition('acked', reason);
  }

  private async deadLetter(queueUrl: string, message: Message, reason: string): Promise<void> {
    this.logger.error(`dead-lettering message ${message.MessageId}: ${reason}`);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.queues.url(this.config.sqs.wagerDlqName),
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { failureReason: { DataType: 'String', StringValue: reason } },
      }),
    );
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
    this.hooks?.disposition?.('dead-lettered', reason);
    this.metrics?.messageDisposition('dead-lettered', reason);
  }

  private async changeVisibility(
    queueUrl: string,
    message: Message,
    seconds: number,
  ): Promise<void> {
    await this.sqs
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      )
      .catch((error: unknown) => this.logger.warn(`could not change visibility: ${String(error)}`));
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
