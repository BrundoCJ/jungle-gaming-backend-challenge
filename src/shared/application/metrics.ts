export type Channel = 'http' | 'sqs' | 'worker';
export type MessageDisposition = 'acked' | 'retry' | 'dead-lettered';

/** Port for operational metrics; the application never depends on a metrics library. */
export abstract class MetricsRecorder {
  abstract transactionSettled(kind: string, status: string, channel: Channel): void;
  abstract duplicateDetected(channel: Channel, mechanism: 'idempotency-key' | 'inbox'): void;
  abstract processingDuration(channel: Channel, outcome: string, seconds: number): void;
  abstract messageDisposition(disposition: MessageDisposition, reason: string): void;
  abstract lockConflict(): void;
  abstract outboxPublished(published: number, failed: number): void;
  abstract outboxLag(seconds: number): void;
  abstract reconciliationMismatch(): void;
}
