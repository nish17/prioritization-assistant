import pg from "pg";
import { logError } from "../log.js";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  // Never log err.message or err.detail from Postgres: they can quote row content.
  pool.on("error", (err) => logError("pg_pool_error", err));
  return pool;
}

/**
 * Runs fn in one transaction on one pooled client, holding the per-user advisory lock.
 * Every write (upserts, status changes, run windows, reset, wipe) goes through here, so
 * parallel tool calls from Claude are serialized per user.
 */
export async function withUserLock<T>(pool: Pool, userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    await lockUser(client, userId);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function lockUser(client: Client, userId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('prioritizer:' || $1::text, 0))", [userId]);
}
