import type { MigrationObject } from '@mikro-orm/core';
import { CreateWalletsAndWagerTransactions } from './001-create-wallets-and-wager-transactions';

/**
 * Ordered, explicit list of migrations. Names are stable identifiers stored
 * in the schema_migrations table; never rename or reorder applied entries.
 */
export const MIGRATIONS: MigrationObject[] = [
  { name: '001_create_wallets_and_wager_transactions', class: CreateWalletsAndWagerTransactions },
];
