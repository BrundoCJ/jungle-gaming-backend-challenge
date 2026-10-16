import type { WagerTransaction } from '../domain/wager-transaction';

export interface PendingReferenceCandidate {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  insert(transaction: WagerTransaction): Promise<void>;
  /** Persists status, reference, failure code, observed balance and retry fields. */
  update(transaction: WagerTransaction): Promise<void>;
  /** True when a PROCESSED REFUND/ROLLBACK already targets `referenceTransactionId`. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]>;
}
