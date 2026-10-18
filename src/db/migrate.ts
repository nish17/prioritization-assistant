import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPool, type Pool } from "./pool.js";

const MIGRATION_LOCK = 7_262_001;

export function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), "src/db/migrations");
}

/** Applies pending .sql migrations in name order, each in its own transaction. Safe to run concurrently. */
export async function migrate(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(resolve(migrationsDir(), file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
      applied.push(file);
    }
    return applied;
  } finally {
    // The lock is session-level: if unlocking fails, destroy the connection so the lock can't leak into the pool.
    const unlocked = await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).then(
      () => true,
      () => false,
    );
    client.release(!unlocked);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const pool = createPool(url);
  migrate(pool)
    .then((applied) => console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date"))
    .catch((err) => {
      console.error("migration failed:", err instanceof Error ? err.message : "unknown");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
