import { Migration } from '@mikro-orm/migrations';

/**
 * Wallets and wager transactions. Every invariant that can be expressed in
 * the schema lives here, not only in application code.
 */
export class CreateWalletsAndWagerTransactions extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   uuid           NOT NULL,
        currency    char(3)        NOT NULL,
        balance     numeric(20, 2) NOT NULL,
        version     integer        NOT NULL,
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_currency_iso4217 CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1)
      )
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        text           NOT NULL,
        external_transaction_id            text           NOT NULL,
        idempotency_key                    text           NOT NULL,
        payload_hash                       char(64)       NOT NULL,
        wallet_id                          uuid           NOT NULL REFERENCES wallets (id),
        player_id                          uuid           NOT NULL,
        round_id                           text           NOT NULL,
        game_id                            text           NOT NULL,
        kind                               text           NOT NULL,
        amount                             numeric(20, 2) NOT NULL,
        currency                           char(3)        NOT NULL,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid           REFERENCES wager_transactions (id),
        status                             text           NOT NULL,
        failure_code                       text,
        observed_balance                   numeric(20, 2),
        reference_attempts                 integer        NOT NULL DEFAULT 0,
        next_reference_check_at            timestamptz,
        created_at                         timestamptz    NOT NULL,
        processed_at                       timestamptz,

        CONSTRAINT wager_transactions_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_provider_external_unique UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT wager_transactions_kind_valid
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_valid
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_transactions_amount_valid
          CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT wager_transactions_observed_balance_non_negative
          CHECK (observed_balance >= 0),
        CONSTRAINT wager_transactions_reference_attempts_non_negative
          CHECK (reference_attempts >= 0),

        -- REFUND/ROLLBACK must name a reference; BET/OPENING never do.
        CONSTRAINT wager_transactions_reversal_requires_reference
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_transactions_no_reference_for_bet
          CHECK (kind NOT IN ('BET', 'OPENING') OR reference_external_transaction_id IS NULL),
        CONSTRAINT wager_transactions_no_self_reference
          CHECK (reference_transaction_id IS DISTINCT FROM id),

        -- A failure code exists exactly for REJECTED/FAILED; terminal states are timestamped;
        -- PROCESSED always records the balance observed (returned on replay).
        CONSTRAINT wager_transactions_failure_code_matches_status
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_transactions_terminal_has_processed_at
          CHECK ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at IS NOT NULL)),
        CONSTRAINT wager_transactions_processed_has_balance
          CHECK (status <> 'PROCESSED' OR observed_balance IS NOT NULL),
        CONSTRAINT wager_transactions_pending_reference_scheduled
          CHECK (status <> 'PENDING_REFERENCE' OR next_reference_check_at IS NOT NULL)
      )
    `);

    // A transaction can be reversed (REFUND or ROLLBACK) at most once. WIN/LOSS
    // may also reference a BET, so they are excluded from this rule.
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_due
        ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_wallet_created
        ON wager_transactions (wallet_id, created_at)
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE wager_transactions');
    this.addSql('DROP TABLE wallets');
  }
}
