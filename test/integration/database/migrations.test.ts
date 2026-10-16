import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MIGRATIONS } from '../../../src/platform/database/migrations';
import { createTestDatabase, sql, type TestDatabase } from '../support/test-database';

const APP_TABLES = [
  'inbox_messages',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];

let db: TestDatabase;

async function appTables(): Promise<string[]> {
  const rows = (await sql(
    db,
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name <> 'schema_migrations'
      order by table_name`,
  )) as { table_name: string }[];
  return rows.map((row) => row.table_name);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await db.dispose();
});

describe('migrations', () => {
  it('apply in order', async () => {
    const applied = await db.orm.migrator.up();

    expect(applied.map((m) => m.name)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(await appTables()).toEqual(APP_TABLES);
  });

  it('are fully reversible', async () => {
    await db.orm.migrator.down({ to: 0 });

    expect(await appTables()).toEqual([]);
    expect(await db.orm.migrator.getExecuted()).toEqual([]);
  });

  it('can be re-applied after a rollback', async () => {
    await db.orm.migrator.up();

    expect(await appTables()).toEqual(APP_TABLES);
    expect(await db.orm.migrator.getPending()).toEqual([]);
  });
});
