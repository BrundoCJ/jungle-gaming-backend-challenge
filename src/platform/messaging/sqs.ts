import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { EventPublisher } from '../../modules/messaging/application/event-publisher';
import type { OutboxMessage } from '../../modules/messaging/domain/outbox-message';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export function createSqsClient(config: AppConfig): SQSClient {
  const usingEmulator = config.aws.endpoint !== undefined;
  return new SQSClient({
    region: config.aws.region,
    endpoint: config.aws.endpoint,
    // Local emulators accept any credentials; real AWS uses the default chain.
    ...(usingEmulator && !process.env.AWS_ACCESS_KEY_ID
      ? { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
      : {}),
  });
}

/** Resolves (and caches) queue URLs by name. */
@Injectable()
export class QueueDirectory {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}

  url(queueName: string): Promise<string> {
    let url = this.urls.get(queueName);
    if (!url) {
      url = this.client.send(new GetQueueUrlCommand({ QueueName: queueName })).then((result) => {
        if (!result.QueueUrl) {
          throw new Error(`queue ${queueName} not found`);
        }
        return result.QueueUrl;
      });
      url.catch(() => this.urls.delete(queueName));
      this.urls.set(queueName, url);
    }
    return url;
  }
}

/**
 * Publishes outbox events to the FIFO events queue. Ordered per aggregate
 * (MessageGroupId) and deduplicated by eventId within SQS's window;
 * consumers must still deduplicate by eventId (delivery is at-least-once).
 */
@Injectable()
export class SqsEventPublisher extends EventPublisher {
  constructor(
    @Inject(SQSClient) private readonly client: SQSClient,
    @Inject(QueueDirectory) private readonly queues: QueueDirectory,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queues.url(this.config.sqs.eventsQueueName),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
      }),
    );
  }
}
