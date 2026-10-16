import { describe, expect, it } from 'bun:test';
import { AppLogger } from '../../../src/platform/logging/app-logger';
import { bindLogContext, runWithLogContext } from '../../../src/platform/logging/log-context';
import { createRootLogger } from '../../../src/platform/logging/root-logger';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { logLevel: 'info', instanceId: 'test-instance' },
    { write: (chunk: string) => lines.push(JSON.parse(chunk)) },
  );
  return { logger, lines };
}

describe('root logger', () => {
  it('emits JSON lines with the active log context', () => {
    const { logger, lines } = captureLogger();

    runWithLogContext({ correlationId: 'corr-1' }, () => {
      bindLogContext({ walletId: 'wallet-1', providerId: 'provider-a' });
      logger.info('processing');
    });

    expect(lines[0]).toMatchObject({
      level: 'info',
      message: 'processing',
      instanceId: 'test-instance',
      correlationId: 'corr-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
    });
  });

  it('redacts money and payload fields', () => {
    const { logger, lines } = captureLogger();

    logger.info(
      { money: { amount: '25.00', currency: 'BRL' }, data: { amount: '10.00' }, payload: {} },
      'redaction',
    );

    expect(lines[0]).toMatchObject({
      money: '[REDACTED]',
      data: { amount: '[REDACTED]' },
      payload: '[REDACTED]',
    });
  });

  it('does not leak context outside of its scope', () => {
    const { logger, lines } = captureLogger();

    runWithLogContext({ correlationId: 'scoped' }, () => undefined);
    logger.info('outside');

    expect(lines[0]?.correlationId).toBeUndefined();
  });
});

describe('AppLogger', () => {
  it('maps the Nest context argument to a field', () => {
    const { logger, lines } = captureLogger();

    new AppLogger(logger).log('started', 'Bootstrap');

    expect(lines[0]).toMatchObject({ level: 'info', message: 'started', context: 'Bootstrap' });
  });
});
