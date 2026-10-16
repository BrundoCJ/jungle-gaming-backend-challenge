import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDatabase, sql, type TestDatabase } from '../support/test-database';

describe('database bootstrap', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.dispose();
  });

  it('connects to PostgreSQL through MikroORM', async () => {
    expect(await db.orm.isConnected()).toBe(true);
    const rows = (await sql(db, 'select 1 as ok')) as { ok: number }[];
    expect(rows[0]?.ok).toBe(1);
  });

  it('tracks executed migrations in schema_migrations', async () => {
    const rows = (await sql(
      db,
      `select count(*)::int as tables from information_schema.tables where table_name = 'schema_migrations'`,
    )) as { tables: number }[];
    expect(rows[0]?.tables).toBe(1);
  });
});
