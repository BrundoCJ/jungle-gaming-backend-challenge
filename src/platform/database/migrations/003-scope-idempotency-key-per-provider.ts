import { Migration } from '@mikro-orm/migrations';

/**
 * Idempotency keys are chosen by each provider, so two providers may use the
 * same key for unrelated transactions. Uniqueness is now per provider.
 */
export class ScopeIdempotencyKeyPerProvider extends Migration {
  override up(): void {
    this.addSql(
      'ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_idempotency_key_unique',
    );
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_transactions_provider_idempotency_key_unique
        UNIQUE (provider_id, idempotency_key)
    `);
  }

  // Fails if two providers already share a key, which is the intended safety net.
  override down(): void {
    this.addSql(
      'ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_provider_idempotency_key_unique',
    );
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_transactions_idempotency_key_unique UNIQUE (idempotency_key)
    `);
  }
}
