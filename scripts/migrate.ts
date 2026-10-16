/**
 * Migration CLI.
 *   bun scripts/migrate.ts up [name]     apply pending migrations (optionally up to `name`)
 *   bun scripts/migrate.ts down [name]   revert the last migration (or down to `name`; "0" = all)
 *   bun scripts/migrate.ts status        list executed and pending migrations
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/platform/config/app-config';
import { createOrmOptions } from '../src/platform/database/orm-options';

const [command = 'up', target] = process.argv.slice(2);
const orm = await MikroORM.init(createOrmOptions(loadConfig().database.url));

try {
  switch (command) {
    case 'up': {
      const applied = await orm.migrator.up(target ? { to: target } : undefined);
      console.log(`applied: ${applied.map((m) => m.name).join(', ') || 'none'}`);
      break;
    }
    case 'down': {
      const to = target === '0' ? 0 : target;
      const reverted = await orm.migrator.down(to === undefined ? undefined : { to });
      console.log(`reverted: ${reverted.map((m) => m.name).join(', ') || 'none'}`);
      break;
    }
    case 'status': {
      const executed = await orm.migrator.getExecuted();
      const pending = await orm.migrator.getPending();
      console.log(`executed: ${executed.map((m) => m.name).join(', ') || 'none'}`);
      console.log(`pending:  ${pending.map((m) => m.name).join(', ') || 'none'}`);
      break;
    }
    default:
      throw new Error(`unknown command "${command}" (expected up, down or status)`);
  }
} finally {
  await orm.close(true);
}
