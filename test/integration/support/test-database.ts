import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { createOrmOptions } from '../../../src/platform/database/orm-options';

/** Server used by integration tests (the compose Postgres by default). */
const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://wagering:wagering@localhost:5432/postgres';

export interface TestDatabase {
  name: string;
  url: string;
  orm: MikroORM;
  /** Drops the database; call in afterAll. */
  dispose(): Promise<void>;
}

/**
 * Creates an isolated, empty database for one test file, so files never
 * share state and can run in any order.
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const name = `wagering_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new SQL(ADMIN_URL);
  await admin.unsafe(`CREATE DATABASE ${name}`);

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const orm = await MikroORM.init(createOrmOptions(url.toString()));
  if (options.migrate ?? true) {
    await orm.migrator.up();
  }

  return {
    name,
    url: url.toString(),
    orm,
    async dispose() {
      await orm.close(true);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}

/** Runs raw SQL on a fresh connection from the ORM pool. */
export function sql(db: TestDatabase, query: string, params: unknown[] = []): Promise<unknown[]> {
  return db.orm.em.getConnection().execute(query, params) as Promise<unknown[]>;
}
