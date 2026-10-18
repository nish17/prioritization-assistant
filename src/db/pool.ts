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

// Writes queue here, per user, before taking a pool client, so writes waiting on each other never hold
// connections that read tools need. The advisory lock below still serializes across processes.
const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Runs fn in one transaction on one pooled client, holding the per-user advisory lock.
 * Every write (upserts, status changes, run windows, reset, wipe) goes through here, so
 * parallel tool calls from Claude are serialized per user.
 */
export async function withUserLock<T>(pool: Pool, userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const previous = writeQueues.get(userId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => inTransaction(pool, userId, fn));
  const tail = run.catch(() => undefined);
  writeQueues.set(userId, tail);
  void tail.then(() => {
    if (writeQueues.get(userId) === tail) writeQueues.delete(userId);
  });
  return run;
}

async function inTransaction<T>(pool: Pool, userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
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
    // A connection that can't roll back is in an unknown state: destroy it rather than return it to the pool.
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}

export async function lockUser(client: Client, userId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('prioritizer:' || $1::text, 0))", [userId]);
}
