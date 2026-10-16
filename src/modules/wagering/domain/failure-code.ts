/**
 * Stable, machine-readable reasons carried by REJECTED and FAILED
 * transactions. Values never change once published: providers branch on them.
 */
export enum FailureCode {
  WalletNotFound = 'WALLET_NOT_FOUND',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  ProcessingFailed = 'PROCESSING_FAILED',
}

/**
 * What the provider should do next. A rejection is terminal for its
 * idempotency key, so "correct" always means sending a new transaction.
 */
export type ProviderAction =
  | 'NONE'
  | 'CORRECT_AND_SEND_NEW'
  | 'SEND_REFERENCE_FIRST'
  | 'CONTACT_SUPPORT';

export interface FailureCodeInfo {
  description: string;
  providerAction: ProviderAction;
}

export const FAILURE_CODES: Readonly<Record<FailureCode, FailureCodeInfo>> = {
  [FailureCode.WalletNotFound]: {
    description: 'The walletId does not exist.',
    providerAction: 'CORRECT_AND_SEND_NEW',
  },
  [FailureCode.PlayerWalletMismatch]: {
    description: 'The wallet does not belong to the given playerId.',
    providerAction: 'CORRECT_AND_SEND_NEW',
  },
  [FailureCode.CurrencyMismatch]: {
    description: 'The transaction currency differs from the wallet currency.',
    providerAction: 'CORRECT_AND_SEND_NEW',
  },
  [FailureCode.InsufficientFunds]: {
    description: 'The wallet balance does not cover the bet.',
    providerAction: 'NONE',
  },
  [FailureCode.ReversalWouldOverdraw]: {
    description: 'Applying the reversal would make the balance negative; needs manual handling.',
    providerAction: 'CONTACT_SUPPORT',
  },
  [FailureCode.ReferenceNotFound]: {
    description: 'The referenced transaction never arrived within the retry window.',
    providerAction: 'SEND_REFERENCE_FIRST',
  },
  [FailureCode.ReferenceMismatch]: {
    description: 'The reference belongs to another player, wallet, currency or round.',
    providerAction: 'CORRECT_AND_SEND_NEW',
  },
  [FailureCode.ReferenceInvalidKind]: {
    description: 'The reference kind cannot be targeted by this operation.',
    providerAction: 'CORRECT_AND_SEND_NEW',
  },
  [FailureCode.ReferenceNotProcessed]: {
    description: 'The referenced transaction was rejected or failed; there is nothing to act on.',
    providerAction: 'NONE',
  },
  [FailureCode.ReferenceAlreadyReversed]: {
    description: 'The referenced transaction has already been reversed.',
    providerAction: 'NONE',
  },
  [FailureCode.AmountMismatch]: {
    description:
      'Reversal amount differs from the referenced amount (partial reversal unsupported).',
    providerAction: 'CORRECT_AND_SEND_NEW',
  },
  [FailureCode.ProcessingFailed]: {
    description: 'Permanent infrastructure failure; the transaction was not applied.',
    providerAction: 'CONTACT_SUPPORT',
  },
};
