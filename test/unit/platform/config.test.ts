import { describe, expect, it } from 'bun:test';
import { InvalidConfigError, loadConfig } from '../../../src/platform/config/app-config';

describe('loadConfig', () => {
  it('applies local development defaults', () => {
    const config = loadConfig({});

    expect(config.env).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.database.url).toBe('postgres://wagering:wagering@localhost:5432/wagering');
    expect(config.aws.endpoint).toBeUndefined();
    expect(config.sqs.wagerQueueName).toBe('wager-transactions.fifo');
  });

  it('reads explicit values', () => {
    const config = loadConfig({
      PORT: '3001',
      INSTANCE_ID: 'app-1',
      DATABASE_URL: 'postgresql://user:pass@db:5432/app',
      AWS_ENDPOINT_URL: 'http://localstack:4566',
    });

    expect(config.port).toBe(3001);
    expect(config.instanceId).toBe('app-1');
    expect(config.database.url).toBe('postgresql://user:pass@db:5432/app');
    expect(config.aws.endpoint).toBe('http://localstack:4566');
  });

  it.each([
    ['PORT', 'not-a-port'],
    ['LOG_LEVEL', 'loud'],
    ['DATABASE_URL', 'mysql://localhost/db'],
    ['SQS_WAGER_QUEUE_NAME', 'standard-queue'],
  ])('rejects invalid %s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(InvalidConfigError);
  });
});
