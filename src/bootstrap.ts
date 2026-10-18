import type { Config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool, type Pool } from "./db/pool.js";
import { Store } from "./domain/store.js";
import { log, logError } from "./log.js";

export interface AppDeps {
  config: Config;
  pool: Pool;
  store: Store;
  close(): Promise<void>;
}

/** Railway can start the app before Postgres accepts connections: retry for up to ~40 s before giving up. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      logError("db_not_ready", err, { attempt: i });
      await new Promise((r) => setTimeout(r, Math.min(1000 * i, 8000)));
    }
  }
}

export async function bootstrap(config: Config): Promise<AppDeps> {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = createPool(config.databaseUrl);
  const applied = await withRetry(() => migrate(pool));
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
