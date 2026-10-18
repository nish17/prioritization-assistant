import type { Config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool, type Pool } from "./db/pool.js";
import { log } from "./log.js";

export interface AppDeps {
  config: Config;
  pool: Pool;
  close(): Promise<void>;
}

export async function bootstrap(config: Config): Promise<AppDeps> {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = createPool(config.databaseUrl);
  const applied = await migrate(pool);
  log("migrations", { applied: applied.length });
  return {
    config,
    pool,
    close: () => pool.end(),
  };
}
