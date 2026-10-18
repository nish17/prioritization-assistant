import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { countRows, DATA_TABLES, wipe } from "../src/db/wipe.js";
import { freshDb, type TestDb } from "./helpers/pg.js";

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.drop());

async function seedTask(status = "open"): Promise<{ userId: string; taskId: string }> {
  const u = await db.pool.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ('u' || gen_random_uuid() || '@example.com') RETURNING id",
  );
  const userId = u.rows[0]!.id;
  const t = await db.pool.query<{ id: string }>(
    `INSERT INTO tasks (user_id, title, title_norm, kind, rules_version, status, closed_at)
     VALUES ($1, 'Send deck', 'send deck', 'ask', '2', $2, CASE WHEN $2 = 'done' THEN now() END) RETURNING id`,
    [userId, status],
  );
  return { userId, taskId: t.rows[0]!.id };
}

describe("schema (Unit 1)", () => {
  it("has pg_trgm installed", async () => {
    const { rows } = await db.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'");
    expect(rows).toHaveLength(1);
  });

  it("treats a second migration run as a no-op", async () => {
    expect(await migrate(db.pool)).toEqual([]);
  });

  it("rejects a link from a task to itself", async () => {
    const { taskId } = await seedTask();
    await expect(
      db.pool.query("INSERT INTO task_links (from_task_id, to_task_id, link_type) VALUES ($1, $1, 'related')", [taskId]),
    ).rejects.toThrow(/check/i);
  });

  it("rejects a done task with no closed_at, and an open task with one", async () => {
    const { userId } = await seedTask();
    await expect(
      db.pool.query("INSERT INTO tasks (user_id, title, title_norm, kind, rules_version, status) VALUES ($1, 'x', 'x', 'ask', '2', 'done')", [userId]),
    ).rejects.toThrow(/check/i);
    await expect(
      db.pool.query("INSERT INTO tasks (user_id, title, title_norm, kind, rules_version, closed_at) VALUES ($1, 'x', 'x', 'ask', '2', now())", [userId]),
    ).rejects.toThrow(/check/i);
  });

  it("rejects a source with a null thread_key", async () => {
    const { taskId } = await seedTask();
    await expect(
      db.pool.query(
        "INSERT INTO task_sources (task_id, source, external_id, item_key, thread_key, role, occurred_at) VALUES ($1, 'gmail', 'm1', 'm1', NULL, 'origin', now())",
        [taskId],
      ),
    ).rejects.toThrow(/null/i);
  });

  it("refuses a duplicate (task, source, item_key) row", async () => {
    const { taskId } = await seedTask();
    const insert = () =>
      db.pool.query(
        "INSERT INTO task_sources (task_id, source, external_id, item_key, thread_key, role, occurred_at) VALUES ($1, 'gmail', 'm1', 'm1', 't1', 'origin', now())",
        [taskId],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate/i);
  });

  it("cascades task deletion to sources, links and events, and nulls outcome task ids", async () => {
    const { userId, taskId } = await seedTask();
    const other = await seedTask();
    await db.pool.query(
      "INSERT INTO task_sources (task_id, source, external_id, item_key, thread_key, role, occurred_at) VALUES ($1, 'gmail', 'm9', 'm9', 't9', 'origin', now())",
      [taskId],
    );
    await db.pool.query("INSERT INTO task_links (from_task_id, to_task_id, link_type) VALUES ($1, $2, 'related')", [taskId, other.taskId]);
    await db.pool.query("INSERT INTO task_events (task_id, actor, event_type) VALUES ($1, 'claude', 'created')", [taskId]);
    const o = await db.pool.query<{ id: string }>(
      "INSERT INTO ingest_outcomes (user_id, source, external_id, item_key, outcome, task_id) VALUES ($1, 'gmail', 'm9', 'm9', 'created', $2) RETURNING id",
      [userId, taskId],
    );
    await db.pool.query("DELETE FROM tasks WHERE id = $1", [taskId]);
    const left = await db.pool.query(
      `SELECT (SELECT count(*) FROM task_sources WHERE task_id = $1) AS s,
              (SELECT count(*) FROM task_links WHERE from_task_id = $1 OR to_task_id = $1) AS l,
              (SELECT count(*) FROM task_events WHERE task_id = $1) AS e`,
      [taskId],
    );
    expect(left.rows[0]).toEqual({ s: "0", l: "0", e: "0" });
    const outcome = await db.pool.query("SELECT task_id FROM ingest_outcomes WHERE id = $1", [o.rows[0]!.id]);
    expect(outcome.rows[0].task_id).toBeNull();
  });

  it("wipes every data table to zero rows and keeps the migrations ledger", async () => {
    const { userId, taskId } = await seedTask();
    const run = await db.pool.query<{ id: string }>(
      "INSERT INTO ingest_runs (user_id, source, mode, window_from, window_to) VALUES ($1, 'gmail', 'backfill', now() - interval '1 day', now()) RETURNING id",
      [userId],
    );
    await db.pool.query("INSERT INTO sync_state (user_id, source) VALUES ($1, 'gmail')", [userId]);
    await db.pool.query("INSERT INTO user_settings (user_id) VALUES ($1)", [userId]);
    await db.pool.query("INSERT INTO task_events (task_id, actor, event_type) VALUES ($1, 'claude', 'created')", [taskId]);
    await db.pool.query(
      "INSERT INTO ingest_outcomes (user_id, run_id, source, external_id, item_key, outcome, task_id) VALUES ($1, $2, 'gmail', 'm1', 'm1', 'created', $3)",
      [userId, run.rows[0]!.id, taskId],
    );
    await wipe(db.pool);
    const counts = await countRows(db.pool);
    expect(Object.keys(counts)).toEqual([...DATA_TABLES]);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    const ledger = await db.pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(ledger.rows[0].n).toBeGreaterThan(0);
  });
});
