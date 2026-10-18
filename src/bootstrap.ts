import type { Config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool, type Pool } from "./db/pool.js";
import { Store } from "./domain/store.js";
import { log } from "./log.js";

export interface AppDeps {
  config: Config;
  pool: Pool;
  store: Store;
  close(): Promise<void>;
}

export async function bootstrap(config: Config): Promise<AppDeps> {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = createPool(config.databaseUrl);
  const applied = await migrate(pool);
  const store = new Store({
    pool,
    userEmail: config.pocUserEmail,
    userName: config.pocUserName,
    timezone: config.timezone,
    backfillDays: config.backfillDays,
    sliceDays: config.sliceDays,
  });
  await store.userId(); // seed the POC user idempotently
  log("ready", { migrationsApplied: applied.length, backfillDays: config.backfillDays, sliceDays: config.sliceDays });
  return { config, pool, store, close: () => pool.end() };
}
