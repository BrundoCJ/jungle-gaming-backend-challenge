import { Injectable } from '@nestjs/common';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import {
  type Channel,
  type MessageDisposition,
  MetricsRecorder,
} from '../../shared/application/metrics';

/** Prometheus implementation of the metrics port, exposed on GET /metrics. */
@Injectable()
export class PrometheusMetrics extends MetricsRecorder {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions settled, by kind, final status and entry channel',
    labelNames: ['kind', 'status', 'channel'],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicate requests/messages absorbed (idempotency key replay or inbox hit)',
    labelNames: ['channel', 'mechanism'],
    registers: [this.registry],
  });

  private readonly duration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Time to process a wager transaction, including locking and commit',
    labelNames: ['channel', 'outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly messages = new Counter({
    name: 'sqs_messages_total',
    help: 'Consumed SQS messages by disposition (acked, retry, dead-lettered) and reason',
    labelNames: ['disposition', 'reason'],
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'sqs_message_retries_total',
    help: 'SQS messages returned to the queue after a transient failure',
    registers: [this.registry],
  });

  private readonly deadLettered = new Counter({
    name: 'sqs_dead_lettered_total',
    help: 'SQS messages sent to the DLQ by the consumer',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: 'db_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks and version conflicts that forced a transaction retry',
    registers: [this.registry],
  });

  private readonly outbox = new Counter({
    name: 'outbox_messages_total',
    help: 'Outbox publication attempts by result',
    labelNames: ['result'],
    registers: [this.registry],
  });

  private readonly lag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message (0 when empty)',
    registers: [this.registry],
  });

  private readonly mismatches = new Counter({
    name: 'wallet_reconciliation_mismatches_total',
    help: 'Reconciliations where stored balance and ledger disagreed',
    registers: [this.registry],
  });

  constructor() {
    super();
    collectDefaultMetrics({ register: this.registry });
  }

  transactionSettled(kind: string, status: string, channel: Channel): void {
    this.transactions.inc({ kind, status, channel });
  }

  duplicateDetected(channel: Channel, mechanism: 'idempotency-key' | 'inbox'): void {
    this.duplicates.inc({ channel, mechanism });
  }

  processingDuration(channel: Channel, outcome: string, seconds: number): void {
    this.duration.observe({ channel, outcome }, seconds);
  }

  messageDisposition(disposition: MessageDisposition, reason: string): void {
    this.messages.inc({ disposition, reason });
    if (disposition === 'retry') {
      this.retries.inc();
    }
    if (disposition === 'dead-lettered') {
      this.deadLettered.inc({ reason });
    }
  }

  lockConflict(): void {
    this.lockConflicts.inc();
  }

  outboxPublished(published: number, failed: number): void {
    if (published > 0) this.outbox.inc({ result: 'published' }, published);
    if (failed > 0) this.outbox.inc({ result: 'failed' }, failed);
  }

  outboxLag(seconds: number): void {
    this.lag.set(seconds);
  }

  reconciliationMismatch(): void {
    this.mismatches.inc();
  }
}
