import {
  addMilliseconds,
  type BackoffPolicy,
  backoffDelayMs,
} from '../../../shared/domain/backoff';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../shared/domain/domain-error';
import type { Money } from '../../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry';
import type { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  /** Internal: credit of the wallet's initial balance. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted, not applied yet. */
  Pending = 'PENDING',
  /** Waiting for the referenced transaction to arrive. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied (terminal). */
  Processed = 'PROCESSED',
  /** Business rule violation (terminal). */
  Rejected = 'REJECTED',
  /** Permanent infrastructure error (terminal, auditable). */
  Failed = 'FAILED',
}

/** Kinds a provider may submit; OPENING is internal only. */
export const PROVIDER_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export interface ReferenceRetryPolicy extends BackoffPolicy {
  maxAttempts: number;
}

/** 1s, 2s, 4s ... 128s: gives up after ~4 minutes without the reference. */
export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  maxAttempts: 8,
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Provider-side id of the referenced transaction (not the internal id). */
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  /** Wallet balance observed when the transaction became terminal (returned on replay). */
  observedBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceCheckAt: Date | undefined;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  at: Date;
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Valid transitions:
 *   PENDING           -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 *   PENDING_REFERENCE -> PENDING_REFERENCE (retry) | PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED are terminal.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _observedBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
  ) {}

  /** Provider transaction; starts PENDING. Validates the reference rules per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId: reference } = props;

    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
    }
    if (!props.idempotencyKey || !props.payloadHash) {
      throw new InvalidWagerTransactionError('idempotencyKey and payloadHash are required');
    }
    if (
      (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) &&
      !reference
    ) {
      throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if (kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidWagerTransactionError('BET cannot reference another transaction');
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('a transaction cannot reference itself');
    }
    if (kind === WagerTransactionKind.Loss ? money.isNegative() : !money.isPositive()) {
      throw new InvalidWagerTransactionError(`${kind} amount must be positive`);
    }

    return WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      observedBalance: undefined,
      referenceAttempts: 0,
      nextReferenceCheckAt: undefined,
    });
  }

  /** Internal OPENING credit, created already PROCESSED with the wallet. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: props.id,
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `internal:opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: props.at,
      observedBalance: props.money,
      referenceAttempts: 0,
      nextReferenceCheckAt: undefined,
    });
  }

  /** Rebuilds persisted state; does not re-validate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.referenceAttempts,
      state.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transitions (throw InvalidTransactionStateError from a terminal state)

  markProcessed(params: {
    referenceTransactionId: string | undefined;
    observedBalance: Money;
    at: Date;
  }): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = params.referenceTransactionId;
    this._observedBalance = params.observedBalance;
    this._processedAt = params.at;
    this._nextReferenceCheckAt = undefined;
  }

  /** Parks the transaction until its reference arrives and schedules the next check. */
  markPendingReference(now: Date, policy: ReferenceRetryPolicy): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = addMilliseconds(
      now,
      backoffDelayMs(this._referenceAttempts, policy),
    );
  }

  reject(code: FailureCode, params: { observedBalance: Money | undefined; at: Date }): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = params.observedBalance;
    this._processedAt = params.at;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** False for LOSS: it records the round outcome without moving the balance. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  referenceRetriesExhausted(policy: ReferenceRetryPolicy): boolean {
    return this._referenceAttempts >= policy.maxAttempts;
  }

  /** ROLLBACK inverts its reference; everything else has a fixed direction. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError('ROLLBACK direction depends on its reference');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not move the balance');
    }
  }

  private assertNotTerminal(target: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, target);
    }
  }
}
