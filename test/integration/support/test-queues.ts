import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566';

export const testSqsClient = () =>
  new SQSClient({
    region: 'us-east-1',
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

export interface TestQueues {
  client: SQSClient;
  wagerQueueName: string;
  wagerQueueUrl: string;
  dlqName: string;
  dlqUrl: string;
  eventsQueueName: string;
  eventsQueueUrl: string;
  /** Env overrides pointing the app at these queues. */
  env: Record<string, string>;
  dispose(): Promise<void>;
}

/** Isolated FIFO queues (wager queue with DLQ redrive, events queue) for one test file. */
export async function createTestQueues(
  options: { maxReceiveCount?: number } = {},
): Promise<TestQueues> {
  const client = testSqsClient();
  const suffix = randomUUID().slice(0, 8);
  const dlqName = `test-wager-dlq-${suffix}.fifo`;
  const wagerQueueName = `test-wager-${suffix}.fifo`;
  const eventsQueueName = `test-events-${suffix}.fifo`;

  const dlq = await client.send(
    new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true' } }),
  );
  const dlqUrl = dlq.QueueUrl as string;
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const wager = await client.send(
    new CreateQueueCommand({
      QueueName: wagerQueueName,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes?.QueueArn,
          maxReceiveCount: String(options.maxReceiveCount ?? 3),
        }),
      },
    }),
  );
  const events = await client.send(
    new CreateQueueCommand({ QueueName: eventsQueueName, Attributes: { FifoQueue: 'true' } }),
  );

  const urls = [wager.QueueUrl, dlqUrl, events.QueueUrl] as string[];
  return {
    client,
    wagerQueueName,
    wagerQueueUrl: wager.QueueUrl as string,
    dlqName,
    dlqUrl,
    eventsQueueName,
    eventsQueueUrl: events.QueueUrl as string,
    env: {
      AWS_ENDPOINT_URL: SQS_ENDPOINT,
      SQS_WAGER_QUEUE_NAME: wagerQueueName,
      SQS_WAGER_DLQ_NAME: dlqName,
      SQS_EVENTS_QUEUE_NAME: eventsQueueName,
      SQS_WAIT_TIME_SECONDS: '1',
    },
    async dispose() {
      for (const QueueUrl of urls) {
        await client.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined);
      }
      client.destroy();
    },
  };
}

/** Receives and deletes everything currently visible in a queue. */
export async function drainQueue(client: SQSClient, queueUrl: string): Promise<Message[]> {
  const received: Message[] = [];
  for (let emptyPolls = 0; emptyPolls < 2; ) {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    if (Messages.length === 0) {
      emptyPolls += 1;
      continue;
    }
    for (const message of Messages) {
      received.push(message);
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }
  return received;
}

export async function sendFifo(
  client: SQSClient,
  queueUrl: string,
  body: string,
  groupId: string,
  deduplicationId = randomUUID(),
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}
