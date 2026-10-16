import { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { EventPublisher } from '../../modules/messaging/application/event-publisher';
import {
  OUTBOX_BATCH_SIZE,
  OutboxPublisher,
} from '../../modules/messaging/application/outbox-publisher';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { AppLogger } from '../logging/app-logger';
import { PollingLoop } from '../workers/polling-loop';
import { createSqsClient, QueueDirectory, SqsEventPublisher } from './sqs';

/** Runs the outbox publisher in the background when enabled. */
@Injectable()
class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    @Inject(OutboxPublisher) publisher: OutboxPublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AppLogger) logger: AppLogger,
  ) {
    this.loop = new PollingLoop(
      'OutboxPublisherWorker',
      async () => (await publisher.publishPending()).claimed === OUTBOX_BATCH_SIZE,
      config.workers.outboxPollIntervalMs,
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.workers.outboxPublisher) {
      this.loop.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }
}

@Global()
@Module({
  providers: [
    { provide: SQSClient, inject: [APP_CONFIG], useFactory: createSqsClient },
    QueueDirectory,
    { provide: EventPublisher, useClass: SqsEventPublisher },
    OutboxPublisher,
    OutboxPublisherWorker,
  ],
  exports: [SQSClient, QueueDirectory, EventPublisher, OutboxPublisher],
})
export class MessagingModule {}
