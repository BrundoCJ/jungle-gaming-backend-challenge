import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { MIGRATIONS } from './migrations';
import { PERSISTENCE_SCHEMAS } from './persistence/schemas';

/**
 * Single source of MikroORM configuration for the app, the migration CLI
 * and the integration tests. Migrations are hand-written SQL listed in
 * code (no file discovery, no schema snapshots).
 */
export function createOrmOptions(databaseUrl: string, overrides: Options = {}): Options {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: PERSISTENCE_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'schema_migrations',
      snapshot: false,
      snapshotOnMigrate: false,
      silent: true,
    },
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    pool: { min: 0, max: 10 },
    ...overrides,
  });
}
