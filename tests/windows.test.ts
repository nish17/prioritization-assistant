import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { wipe } from "../src/db/wipe.js";
import type { Store } from "../src/domain/store.js";
import { gmail, granola, makeStore, newTask, updateTask, type Clock } from "./helpers/fixtures.js";
import { freshDb, type TestDb } from "./helpers/pg.js";

let db: TestDb;
const clock: Clock = { now: new Date("2026-10-19T12:45:00+05:30") };
let store: Store;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.drop());
beforeEach(async () => {
  await wipe(db.pool);
  clock.now = new Date("2026-10-19T12:45:00+05:30");
  store = makeStore(db, clock);
});

type Started = { status: "started"; run_id: string; window_from: string; window_to: string; is_last_slice: boolean; query_hints: Record<string, string> };
const start = async (mode: "backfill" | "refresh", source: "gmail" | "slack" | "gcal" | "granola" = "gmail") => {
  const r = await store.startRun(mode, source);
  return r as Started;
};
const okCounts = { fetched: 10, evaluated: 8, not_a_task: 3 };
const ist = (s: string) => new Date(`${s}+05:30`).toISOString();

describe("backfill slices (newest first)", () => {
  it("steps back from the anchor in 7-day slices and completes after 30 days", async () => {
    const first = await start("backfill");
    expect(first.window_to).toBe(ist("2026-10-19T12:45:00"));
    expect(first.window_from).toBe(ist("2026-10-12T12:45:00"));
    expect(first.is_last_slice).toBe(false);
    const windows: [string, string, boolean][] = [];
    let r = first;
    for (let i = 0; i < 5; i++) {
      windows.push([r.window_from, r.window_to, r.is_last_slice]);
      clock.now = new Date(clock.now.getTime() + 3_600_000); // later chats; the anchor doesn't move
      const done = await store.finishRun(r.run_id, "ok", okCounts);
      expect(done.cursor_advanced).toBe(true);
      if (i < 4) r = await start("backfill");
    }
    expect(windows.map((w) => w[0])).toEqual([
      ist("2026-10-12T12:45:00"),
      ist("2026-10-05T12:45:00"),
      ist("2026-09-28T12:45:00"),
      ist("2026-09-21T12:45:00"),
      ist("2026-09-19T12:45:00"),
    ]);
    expect(windows.map((w) => w[2])).toEqual([false, false, false, false, true]);
    const sync = await store.getSyncState();
    const g = sync.sources.find((s) => s.source === "gmail")!;
    expect(g.backfill_complete).toBe(true);
    const cursor = (await db.pool.query("SELECT refresh_cursor FROM sync_state WHERE source = 'gmail'")).rows[0].refresh_cursor as Date;
    expect(cursor.toISOString()).toBe(ist("2026-10-19T12:45:00"));
    expect((await store.startRun("backfill", "gmail")).status).toBe("backfill_complete");
  });

  it("uses two slices with BACKFILL_DAYS=2 and SLICE_DAYS=1", async () => {
    store = makeStore(db, clock, { backfillDays: 2, sliceDays: 1 });
    const a = await start("backfill");
    expect(a.is_last_slice).toBe(false);
    await store.finishRun(a.run_id, "ok", okCounts);
    const b = await start("backfill");
    expect(b.is_last_slice).toBe(true);
    expect(b.window_from).toBe(ist("2026-10-17T12:45:00"));
    await store.finishRun(b.run_id, "ok", okCounts);
    expect((await store.getSyncState()).sources.find((s) => s.source === "gmail")!.backfill_complete).toBe(true);
  });

  it("leaves the window unchanged after a partial run and stores the error", async () => {
    const a = await start("backfill");
    const done = await store.finishRun(a.run_id, "partial", okCounts, "Gmail search timed out");
    expect(done.cursor_advanced).toBe(false);
    const again = await start("backfill");
    expect([again.window_from, again.window_to]).toEqual([a.window_from, a.window_to]);
    const g = (await store.getSyncState()).sources.find((s) => s.source === "gmail")!;
    expect(g.last_status).toBe("partial");
    expect(g.last_error).toBe("Gmail search timed out");
  });

  it("does not count a capped slice and halves the next one", async () => {
    const a = await start("backfill");
    const done = await store.finishRun(a.run_id, "ok", { ...okCounts, capped: true });
    expect(done.slice_counted).toBe(false);
    const b = await start("backfill");
    expect(b.window_to).toBe(a.window_to);
    expect(new Date(b.window_to).getTime() - new Date(b.window_from).getTime()).toBe(84 * 3_600_000);
  });

  it("ignores finishing the same run twice", async () => {
    const a = await start("backfill");
    await store.finishRun(a.run_id, "ok", okCounts);
    const again = await store.finishRun(a.run_id, "ok", okCounts);
    expect(again.already_finished).toBe(true);
    expect((await store.getSyncState()).sources.find((s) => s.source === "gmail")!.slices_done).toBe(1);
  });
});

describe("refresh and calendar windows", () => {
  it("refuses refresh before backfill completes", async () => {
    const r = await store.startRun("refresh", "gmail");
    expect(r.status).toBe("backfill_incomplete");
  });

  it("starts refresh 1 h before the cursor and advances to the window end", async () => {
    store = makeStore(db, clock, { backfillDays: 1, sliceDays: 1 });
    const b = await start("backfill");
    await store.finishRun(b.run_id, "ok", okCounts);
    clock.now = new Date("2026-10-20T08:00:00+05:30");
    const r = await start("refresh");
    expect(r.window_from).toBe(ist("2026-10-19T11:45:00"));
    expect(r.window_to).toBe(ist("2026-10-20T08:00:00"));
    expect(r.query_hints.window).toBe(`after:${Math.floor(Date.parse(r.window_from) / 1000)} before:${Math.ceil(Date.parse(r.window_to) / 1000)}`);
    expect(r.query_hints.own_replies_since_window_start).toMatch(/^in:sent after:\d+$/);
    expect(r.query_hints.sent_awaiting_reply).toMatch(/^in:sent after:\d+ before:\d+$/);
    await store.finishRun(r.run_id, "ok", okCounts);
    const cursor = (await db.pool.query("SELECT refresh_cursor FROM sync_state WHERE source = 'gmail'")).rows[0].refresh_cursor as Date;
    expect(cursor.toISOString()).toBe(ist("2026-10-20T08:00:00"));
  });

  it("catches up oldest-first in chunks after a capped refresh", async () => {
    store = makeStore(db, clock, { backfillDays: 1, sliceDays: 1 });
    const b = await start("backfill");
    await store.finishRun(b.run_id, "ok", okCounts);
    clock.now = new Date("2026-10-21T12:45:00+05:30");
    const r = await start("refresh");
    await store.finishRun(r.run_id, "ok", { ...okCounts, capped: true });
    const chunk = await start("refresh");
    expect(chunk.window_from).toBe(r.window_from);
    expect(new Date(chunk.window_to).getTime() - new Date(chunk.window_from).getTime()).toBe(24 * 3_600_000);
    const partway = await store.finishRun(chunk.run_id, "ok", okCounts);
    expect(partway.caught_up).toBe(false);
    // Each chunk re-reads the hour before the cursor, so catching up takes a couple more runs.
    let last: Started | undefined;
    for (let i = 0; i < 3; i++) {
      last = await start("refresh");
      if ((await store.finishRun(last.run_id, "ok", okCounts)).caught_up) break;
    }
    expect(last!.window_to).toBe(clock.now.toISOString());
  });

  it("always reads Calendar from now to now + 7 days", async () => {
    const b = await start("backfill", "gcal");
    expect(b.window_from).toBe(clock.now.toISOString());
    expect(b.window_to).toBe(new Date(clock.now.getTime() + 7 * 86_400_000).toISOString());
    expect(b.is_last_slice).toBe(true);
    await store.finishRun(b.run_id, "ok", okCounts);
    clock.now = new Date("2026-10-20T09:00:00+05:30");
    const r = await start("refresh", "gcal");
    expect(r.window_from).toBe(clock.now.toISOString());
    expect(r.query_hints.time_min).toBe(clock.now.toISOString());
  });

  it("widens Slack date hints by a day on each side", async () => {
    const r = await start("backfill", "slack");
    expect(r.query_hints.window).toBe("after:2026-10-11 before:2026-10-20");
  });
});

describe("reset_backfill", () => {
  it("returns to slice 1 and deletes only what that source's backfill wrote", async () => {
    const g1 = await start("backfill");
    const onlyGmail = await store.upsertTask(newTask("Gmail only", [gmail("m1", "T1")], { run_id: g1.run_id }));
    const shared = await store.upsertTask(newTask("Gmail then Granola", [gmail("m2", "T2")], { run_id: g1.run_id }));
    await store.finishRun(g1.run_id, "ok", okCounts);
    const g2 = await start("backfill");
    await store.finishRun(g2.run_id, "ok", okCounts);
    const gr = await start("backfill", "granola");
    await store.upsertTask(updateTask(shared.task_id, [granola("meet1", 1, { role: "update" })], {}, { run_id: gr.run_id }));

    const res = await store.resetBackfill("gmail", true);
    expect(res.deleted_tasks).toBe(1);
    const tasks = (await db.pool.query("SELECT id FROM tasks")).rows.map((r) => r.id);
    expect(tasks).toEqual([shared.task_id]);
    expect(tasks).not.toContain(onlyGmail.task_id);
    const left = (await db.pool.query("SELECT source, item_key FROM task_sources")).rows;
    expect(left).toEqual([{ source: "granola", item_key: "meet1#1" }]);

    const g = (await store.getSyncState()).sources.find((s) => s.source === "gmail")!;
    expect(g.slices_done).toBe(0);
    expect(g.backfill_complete).toBe(false);
    const again = (await store.startRun("backfill", "gmail")) as Started & { slice: { number: number } };
    expect(again.slice.number).toBe(1);
    expect(again.window_to).toBe(clock.now.toISOString());
  });
});
