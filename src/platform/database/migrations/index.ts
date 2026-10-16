import type { MigrationObject } from '@mikro-orm/core';

/**
 * Ordered, explicit list of migrations. Names are stable identifiers stored
 * in the schema_migrations table; never rename or reorder applied entries.
 */
export const MIGRATIONS: MigrationObject[] = [];
