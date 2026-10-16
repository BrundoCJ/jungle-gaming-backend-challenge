import { Migration } from '@mikro-orm/migrations';

/**
 * Append-only ledger (with a deferred check that every wallet balance change
 * has its ledger entry), plus the inbox and outbox tables.
 */
export class CreateLedgerInboxOutbox extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        sequence        bigint         GENERATED ALWAYS AS IDENTITY,
        wallet_id       uuid           NOT NULL REFERENCES wallets (id),
        transaction_id  uuid           NOT NULL REFERENCES wager_transactions (id),
        direction       text           NOT NULL,
        amount          numeric(20, 2) NOT NULL,
        currency        char(3)        NOT NULL,
        balance_before  numeric(20, 2) NOT NULL,
        balance_after   numeric(20, 2) NOT NULL,
        wallet_version  integer        NOT NULL,
        created_at      timestamptz    NOT NULL,
        CONSTRAINT wallet_ledger_entries_sequence_unique UNIQUE (sequence),
        CONSTRAINT wallet_ledger_entries_one_per_transaction UNIQUE (transaction_id),
        CONSTRAINT wallet_ledger_entries_wallet_version_unique UNIQUE (wallet_id, wallet_version),
        CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_balances_non_negative
          CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT wallet_ledger_entries_wallet_version_positive CHECK (wallet_version >= 1),
        CONSTRAINT wallet_ledger_entries_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      )
    `);
    this.addSql(`
      CREATE INDEX wallet_ledger_entries_wallet_sequence
        ON wallet_ledger_entries (wallet_id, sequence)
    `);

    // Ledger rows are immutable: no UPDATE, DELETE or TRUNCATE, ever.
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_append_only() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% refused)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_update_or_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_append_only()
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_append_only()
    `);

    // At commit time, a wallet whose balance/version changed must have the ledger
    // entry that produced exactly that version and balance.
    this.addSql(`
      CREATE FUNCTION wallets_balance_matches_ledger() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.balance = 0 THEN
          RETURN NULL;
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.balance = OLD.balance AND NEW.version = OLD.version THEN
          RETURN NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries e
           WHERE e.wallet_id = NEW.id
             AND e.wallet_version = NEW.version
             AND e.balance_after = NEW.balance
        ) THEN
          RAISE EXCEPTION 'wallets_balance_matches_ledger: wallet % has no ledger entry for version % / balance %',
            NEW.id, NEW.version, NEW.balance
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END
      $$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_balance_matches_ledger
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_balance_matches_ledger()
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text        NOT NULL,
        message_id     text        NOT NULL,
        payload_hash   char(64)    NOT NULL,
        received_at    timestamptz NOT NULL,
        processed_at   timestamptz,
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id)
      )
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid        PRIMARY KEY,
        aggregate_id     text        NOT NULL,
        event_type       text        NOT NULL,
        payload          jsonb       NOT NULL,
        occurred_at      timestamptz NOT NULL,
        attempts         integer     NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        CONSTRAINT outbox_messages_attempts_non_negative CHECK (attempts >= 0)
      )
    `);
    this.addSql(`
      CREATE INDEX outbox_messages_pending
        ON outbox_messages (occurred_at)
        WHERE published_at IS NULL
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE outbox_messages');
    this.addSql('DROP TABLE inbox_messages');
    this.addSql('DROP TRIGGER wallets_balance_matches_ledger ON wallets');
    this.addSql('DROP FUNCTION wallets_balance_matches_ledger()');
    this.addSql('DROP TABLE wallet_ledger_entries');
    this.addSql('DROP FUNCTION wallet_ledger_entries_append_only()');
  }
}
