import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, Injectable, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/auth.guard';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { QueueDirectory } from '../messaging/sqs';

type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: { database: CheckStatus; sqs: CheckStatus };
}

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('readiness check timed out')), CHECK_TIMEOUT_MS),
    ),
  ]);
}

/** Readiness: PostgreSQL answers a query and the wager queue is reachable. */
@Injectable()
export class ReadinessService {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(QueueDirectory) private readonly queues: QueueDirectory,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [database, sqs] = await Promise.all([
      this.probe(() => this.orm.em.getConnection().execute('SELECT 1')),
      this.probe(async () =>
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: await this.queues.url(this.config.sqs.wagerQueueName),
            AttributeNames: ['QueueArn'],
          }),
        ),
      ),
    ]);
    return {
      status: database === 'up' && sqs === 'up' ? 'ok' : 'unavailable',
      checks: { database, sqs },
    };
  }

  private async probe(check: () => Promise<unknown>): Promise<CheckStatus> {
    try {
      await withTimeout(check());
      return 'up';
    } catch {
      return 'down';
    }
  }
}

@Public()
@Controller('health')
export class ReadinessController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    response.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
