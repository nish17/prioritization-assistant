import { pathToFileURL } from "node:url";
import { createPool, lockUser, type Pool } from "./pool.js";

/** Every data table. The migrations ledger is never touched. */
export const DATA_TABLES = [
  "ingest_outcomes",
  "task_events",
  "task_links",
  "task_entities",
  "task_sources",
  "entities",
  "tasks",
  "ingest_runs",
  "sync_state",
  "user_settings",
  "users",
] as const;

export async function countRows(pool: Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of DATA_TABLES) {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    counts[table] = Number(rows[0]?.n ?? 0);
  }
  return counts;
}

/** Empties every data table under each user's write lock, so in-flight writes finish first. */
export async function wipe(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '30s'");
    const { rows } = await client.query<{ id: string }>("SELECT id FROM users ORDER BY id");
    for (const { id } of rows) await lockUser(client, id);
    await client.query(`TRUNCATE ${DATA_TABLES.join(", ")} CASCADE`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const pool = createPool(url);
  (async () => {
    console.log("before:", JSON.stringify(await countRows(pool)));
    await wipe(pool);
    const after = await countRows(pool);
    console.log("after: ", JSON.stringify(after));
    if (Object.values(after).some((n) => n > 0)) throw new Error("rows remain after wipe");
    console.log("wipe complete. The POC user is re-seeded on the next request or restart.");
  })()
    .catch((err) => {
      console.error("wipe failed:", err instanceof Error ? err.message : "unknown");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
