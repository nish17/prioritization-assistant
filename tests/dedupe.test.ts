import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { wipe } from "../src/db/wipe.js";
import type { Store } from "../src/domain/store.js";
import { gcal, gmail, granola, makeStore, newTask, updateTask, type Clock } from "./helpers/fixtures.js";
import { freshDb, type TestDb } from "./helpers/pg.js";

let db: TestDb;
let store: Store;
const clock: Clock = { now: new Date("2026-10-18T10:00:00Z") };

beforeAll(async () => {
  db = await freshDb();
  store = makeStore(db, clock);
});
afterAll(() => db.drop());
beforeEach(async () => {
  await wipe(db.pool);
  clock.now = new Date("2026-10-18T10:00:00Z");
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows as T[];
const taskCount = async () => Number((await q<{ n: string }>("SELECT count(*) AS n FROM tasks"))[0]!.n);
const outcomes = async () => (await q<{ outcome: string }>("SELECT outcome FROM ingest_outcomes ORDER BY id")).map((r) => r.outcome);
const sourcesOf = async (taskId: string) =>
  (await q<{ item_key: string; role: string }>("SELECT item_key, role FROM task_sources WHERE task_id = $1 ORDER BY item_key", [taskId])).map(
    (r) => `${r.item_key}:${r.role}`,
  );
const links = async () => q<{ from_task_id: string; to_task_id: string }>("SELECT from_task_id, to_task_id FROM task_links");
const run = async (source: "gmail" | "granola" | "gcal" = "gmail") => {
  const r = await store.startRun("backfill", source);
  if (r.status !== "started") throw new Error("run not started");
  return r.run_id;
};

describe("Step 2: thread-level", () => {
  it("creates a task for a new ask in a new thread and records the outcome", async () => {
    const r = await store.upsertTask(newTask("Send Q4 deck", [gmail("m1", "T")]));
    expect(r.outcome).toBe("created");
    expect(await taskCount()).toBe(1);
    expect(await outcomes()).toEqual(["created"]);
  });

  it("converts a later message in the thread into the open task", async () => {
    const x = await store.upsertTask(newTask("Send Q4 deck", [gmail("m1", "T")]));
    const r = await store.upsertTask(newTask("Also add the budget slide", [gmail("m2", "T", { occurred_at: "2026-10-17T12:00:00Z" })]));
    expect(r.outcome).toBe("converted");
    expect(r.task_id).toBe(x.task_id);
    expect(r.converted).toBe(true);
    expect(r.matched_title).toBe("Send Q4 deck");
    expect(await taskCount()).toBe(1);
    expect(await outcomes()).toEqual(["created", "converted"]);
  });

  it("creates linked sibling tasks for two asks in one email", async () => {
    const runId = await run();
    const a = await store.upsertTask(newTask("Pick ML lead finalist", [gmail("m1", "T", { ask_index: 1 })], { run_id: runId }));
    const b = await store.upsertTask(newTask("Set up debrief with Sana", [gmail("m1", "T", { ask_index: 2 })], { run_id: runId }));
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("created");
    expect(b.converted).toBeUndefined();
    expect(await taskCount()).toBe(2);
    expect(await links()).toEqual([{ from_task_id: b.task_id, to_task_id: a.task_id }]);
  });

  it("creates three tasks from a Granola note's three action items, and none on a re-run", async () => {
    const first = await run("granola");
    for (const i of [1, 2, 3]) {
      expect((await store.upsertTask(newTask(`Action ${i}`, [granola("meet1", i)], { run_id: first }))).outcome).toBe("created");
    }
    expect(await taskCount()).toBe(3);
    const second = (await store.startRun("backfill", "granola")) as { run_id: string };
    for (const i of [1, 2, 3]) {
      expect((await store.upsertTask(newTask(`Action ${i}`, [granola("meet1", i)], { run_id: second.run_id }))).outcome).toBe("updated");
    }
    expect(await taskCount()).toBe(3);
  });

  it("creates a separate linked task with separate_task", async () => {
    const x = await store.upsertTask(newTask("Send Q4 deck", [gmail("m1", "T")]));
    const r = await store.upsertTask(newTask("Book the venue", [gmail("m3", "T", { occurred_at: "2026-10-17T13:00:00Z" })], { separate_task: true }));
    expect(r.outcome).toBe("created");
    expect(r.task_id).not.toBe(x.task_id);
    expect(r.linked_to).toEqual([x.task_id]);
  });

  it("moves an item off a task it reached only by conversion", async () => {
    const x = await store.upsertTask(newTask("Send Q4 deck", [gmail("m1", "T")]));
    const m2 = gmail("m2", "T", { occurred_at: "2026-10-17T12:00:00Z" });
    expect((await store.upsertTask(newTask("Check references", [m2]))).outcome).toBe("converted");
    const r = await store.upsertTask(newTask("Check references", [m2], { separate_task: true }));
    expect(r.outcome).toBe("moved");
    expect(r.task_id).not.toBe(x.task_id);
    expect(await sourcesOf(x.task_id)).toEqual(["m1:origin"]);
    expect(await sourcesOf(r.task_id)).toEqual(["m2:origin"]);
    expect(r.linked_to).toEqual([x.task_id]);
  });

  it("moves a converted item off a task that is now done", async () => {
    const x = await store.upsertTask(newTask("Send Q4 deck", [gmail("m1", "T")]));
    const m2 = gmail("m2", "T", { occurred_at: "2026-10-17T12:00:00Z" });
    await store.upsertTask(newTask("Check references", [m2]));
    await store.updateStatus({ task_id: x.task_id, status: "done" });
    const r = await store.upsertTask(newTask("Check references", [m2], { separate_task: true }));
    expect(r.outcome).toBe("moved");
    expect(r.status).toBe("open");
    expect(await sourcesOf(x.task_id)).toEqual(["m1:origin"]);
  });

  it("never lets separate_task override an item written as an origin", async () => {
    const x = await store.upsertTask(newTask("Send Q4 deck", [gmail("m1", "T")]));
    const r = await store.upsertTask(newTask("Send Q4 deck", [gmail("m1", "T")], { separate_task: true }));
    expect(r.outcome).toBe("updated");
    expect(r.task_id).toBe(x.task_id);
    expect(await taskCount()).toBe(1);
  });
});

describe("Step 1: item-level", () => {
  it("absorbs ask_index drift on a re-read in a later run", async () => {
    const first = await run();
    await store.upsertTask(newTask("Ask one", [gmail("m1", "T", { ask_index: 1 })], { run_id: first }));
    const second = await store.upsertTask(newTask("Ask two", [gmail("m1", "T", { ask_index: 2 })], { run_id: first }));
    await store.finishRun(first, "ok", { fetched: 1, evaluated: 1, not_a_task: 0 });
    const later = (await store.startRun("refresh", "gmail")) as { status: string };
    expect(later.status).toBe("backfill_incomplete");
    const nextRun = (await store.startRun("backfill", "gmail")) as { run_id: string };
    const r = await store.upsertTask(newTask("Ask three", [gmail("m1", "T", { ask_index: 3 })], { run_id: nextRun.run_id }));
    expect(r.outcome).toBe("converted");
    expect(r.task_id).toBe(second.task_id);
    expect(r.existing_asks?.map((a) => a.title).sort()).toEqual(["Ask one", "Ask two"]);
    expect(await taskCount()).toBe(2);
  });

  it("skips a drifted re-read when all of the item's tasks are done", async () => {
    const first = await run();
    const a = await store.upsertTask(newTask("Ask one", [gmail("m1", "T", { ask_index: 1 })], { run_id: first }));
    await store.finishRun(first, "ok", { fetched: 1, evaluated: 1, not_a_task: 0 });
    await store.updateStatus({ task_id: a.task_id, status: "done" });
    const r = await store.upsertTask(newTask("Ask one again", [gmail("m1", "T", { ask_index: 2 })]));
    expect(r.outcome).toBe("skipped-done");
    expect(r.skipped).toBe(true);
    expect(r.status).toBe("done");
    expect(await taskCount()).toBe(1);
  });

  it("never re-creates an item that was absorbed as evidence onto a done task", async () => {
    const x = await store.upsertTask(newTask("Send deck", [gmail("m1", "T")]));
    await store.updateStatus({ task_id: x.task_id, status: "done" });
    await store.upsertTask(updateTask(x.task_id, [gmail("m2", "T", { role: "update" })]));
    const r = await store.upsertTask(newTask("Thanks note", [gmail("m2", "T", { occurred_at: "2026-10-17T12:00:00Z" })]));
    expect(r).toMatchObject({ task_id: x.task_id, outcome: "skipped-done", skipped: true });
    expect(await taskCount()).toBe(1);
  });

  it("updates, rather than duplicates, the task an evidence item is attached to", async () => {
    const x = await store.upsertTask(newTask("Send deck", [gmail("m1", "T1"), gmail("d1", "T9", { role: "evidence" })]));
    const r = await store.upsertTask(newTask("Deck follow-up", [gmail("d1", "T9", { occurred_at: "2026-10-17T12:00:00Z" })]));
    expect(r).toMatchObject({ task_id: x.task_id, outcome: "updated" });
    expect(await taskCount()).toBe(1);
  });

  it("creates sibling asks written without a run in one burst, and converts them later", async () => {
    await store.upsertTask(newTask("Ask one", [gmail("m1", "T", { ask_index: 1 })]));
    const b = await store.upsertTask(newTask("Ask two", [gmail("m1", "T", { ask_index: 2 })]));
    expect(b.outcome).toBe("created");
    clock.now = new Date(clock.now.getTime() + 60 * 60_000);
    const c = await store.upsertTask(newTask("Ask three", [gmail("m1", "T", { ask_index: 3 })]));
    expect(c.outcome).toBe("converted");
    expect(await taskCount()).toBe(2);
  });

  it("still creates the missing asks when the first run never finished cleanly", async () => {
    const first = await run();
    await store.upsertTask(newTask("Ask one", [gmail("m1", "T", { ask_index: 1 })], { run_id: first }));
    await store.finishRun(first, "partial", { fetched: 1, evaluated: 1, not_a_task: 0 }, "chat ended");
    const retry = await run();
    expect((await store.upsertTask(newTask("Ask one", [gmail("m1", "T", { ask_index: 1 })], { run_id: retry }))).outcome).toBe("updated");
    const b = await store.upsertTask(newTask("Ask two", [gmail("m1", "T", { ask_index: 2 })], { run_id: retry }));
    expect(b.outcome).toBe("created");
    expect(await taskCount()).toBe(2);
  });

  it("skips a re-read of an item whose task is done", async () => {
    const a = await store.upsertTask(newTask("Send deck", [gmail("m1", "T")]));
    await store.updateStatus({ task_id: a.task_id, status: "done" });
    const r = await store.upsertTask(newTask("Send deck", [gmail("m1", "T")]));
    expect(r).toMatchObject({ task_id: a.task_id, outcome: "skipped-done", status: "done", skipped: true });
    expect(await taskCount()).toBe(1);
  });

  it("matches a calendar instance across statuses, and creates a task for the next instance", async () => {
    const prep = await store.upsertTask(newTask("Prep for Acme sync", [gcal("E1")], {}, { due_at: "2026-10-19T09:30:00Z" }));
    await store.updateStatus({ task_id: prep.task_id, status: "done" });
    const again = await store.upsertTask(newTask("Prep for Acme sync", [gcal("E1")]));
    expect(again.outcome).toBe("skipped-done");
    const next = await store.upsertTask(newTask("Prep for Acme sync", [gcal("E2", { occurred_at: "2026-10-24T09:00:00Z" })]));
    expect(next.outcome).toBe("created");
    expect(await taskCount()).toBe(2);
  });

  it("never lets an evidence source trigger the guard", async () => {
    const prep = await store.upsertTask(newTask("Prep for Acme sync", [gcal("E1")]));
    await store.updateStatus({ task_id: prep.task_id, status: "done" });
    const r = await store.upsertTask(newTask("Send agenda", [gmail("m1", "T"), gcal("E1", { role: "evidence" })]));
    expect(r.outcome).toBe("created");
    expect(r.task_id).not.toBe(prep.task_id);
    expect(await sourcesOf(prep.task_id)).toEqual(["E1:origin"]);
    const prepRow = (await q<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [prep.task_id]))[0]!;
    expect(prepRow.status).toBe("done");
  });
});

describe("reopen and newer-wins", () => {
  it("reopens a waiting task on a newer ask, and not on an older item", async () => {
    clock.now = new Date("2026-10-17T10:00:00Z");
    const x = await store.upsertTask(newTask("Send deck", [gmail("m1", "T", { occurred_at: "2026-10-17T08:00:00Z" })]));
    await store.updateStatus({ task_id: x.task_id, status: "waiting_on_others" });
    clock.now = new Date("2026-10-17T12:00:00Z");
    const older = await store.upsertTask(newTask("Old note", [gmail("m0", "T", { occurred_at: "2026-10-17T09:00:00Z" })]));
    expect(older.outcome).toBe("converted");
    expect(older.status).toBe("waiting_on_others");
    const newer = await store.upsertTask(newTask("New ask", [gmail("m2", "T", { occurred_at: "2026-10-17T11:00:00Z" })], {}, { waiting_on_user: true }));
    expect(newer.outcome).toBe("reopened");
    expect(newer.status).toBe("open");
  });

  it("keeps the title and explicit due date, unions flags, and ignores older items", async () => {
    const x = await store.upsertTask(
      newTask("Send Q4 deck", [gmail("m1", "T")], {}, { due_at: "2026-10-20T12:00:00Z", due_confidence: "explicit", risk_flags: ["board"], urgency_language: false }),
    );
    await store.upsertTask(
      updateTask(x.task_id, [gmail("m2", "T", { occurred_at: "2026-10-18T08:00:00Z", role: "update" })], {
        due_at: "2026-10-25",
        due_confidence: "inferred",
        risk_flags: ["kpi_risk"],
        urgency_language: true,
      }),
    );
    let row = (await q<Record<string, unknown>>("SELECT title, due_at, due_confidence, risk_flags, urgency_language, last_activity_at FROM tasks WHERE id = $1", [x.task_id]))[0]!;
    expect(row.title).toBe("Send Q4 deck");
    expect((row.due_at as Date).toISOString()).toBe("2026-10-20T12:00:00.000Z");
    expect(row.due_confidence).toBe("explicit");
    expect((row.risk_flags as string[]).sort()).toEqual(["board", "kpi_risk"]);
    expect(row.urgency_language).toBe(true);
    expect((row.last_activity_at as Date).toISOString()).toBe("2026-10-18T08:00:00.000Z");

    await store.upsertTask(updateTask(x.task_id, [gmail("m0", "T", { occurred_at: "2026-10-16T08:00:00Z", role: "update" })], { urgency_language: false }));
    row = (await q<Record<string, unknown>>("SELECT urgency_language, last_activity_at FROM tasks WHERE id = $1", [x.task_id]))[0]!;
    expect(row.urgency_language).toBe(true);
    expect((row.last_activity_at as Date).toISOString()).toBe("2026-10-18T08:00:00.000Z");
  });
});

describe("validation and updates", () => {
  it("rejects two origin/update sources with no write", async () => {
    await expect(store.upsertTask(newTask("Two origins", [gmail("m1", "T"), gmail("m2", "T")]))).rejects.toThrow(/at most one origin/);
    expect(await taskCount()).toBe(0);
  });

  it("names thread_key when a Gmail source lacks it, and rejects a URL used as a key", async () => {
    await expect(store.upsertTask(newTask("No thread", [gmail("m1", "T", { thread_key: undefined })]))).rejects.toThrow(/sources\[0\]\.thread_key/);
    await expect(store.upsertTask(newTask("URL key", [gmail("https://mail.google.com/x", "T")]))).rejects.toThrow(/sources\[0\]\.external_id/);
    expect(await taskCount()).toBe(0);
  });

  it("errors on update of an unknown task with no write", async () => {
    await expect(store.upsertTask(updateTask("00000000-0000-4000-8000-000000000000", [gmail("m1", "T", { role: "update" })]))).rejects.toThrow(/not found/);
    expect(await q("SELECT 1 FROM task_sources")).toHaveLength(0);
  });

  it("attaches evidence only when updating a done task", async () => {
    const x = await store.upsertTask(newTask("Send deck", [gmail("m1", "T")]));
    await store.updateStatus({ task_id: x.task_id, status: "done" });
    const r = await store.upsertTask(updateTask(x.task_id, [gmail("m2", "T", { role: "update" })], { urgency_language: true }));
    expect(r).toMatchObject({ outcome: "evidence", status: "done" });
    expect(await sourcesOf(x.task_id)).toEqual(["m1:origin", "m2:evidence"]);
    const row = (await q<{ urgency_language: boolean }>("SELECT urgency_language FROM tasks WHERE id = $1", [x.task_id]))[0]!;
    expect(row.urgency_language).toBe(false);
  });

  it("serializes concurrent upserts of the same item into one task", async () => {
    const input = newTask("Send deck", [gmail("m1", "T")]);
    const results = await Promise.all([store.upsertTask(input), store.upsertTask(input), store.upsertTask(input)]);
    expect(await taskCount()).toBe(1);
    expect(results.map((r) => r.outcome).sort()).toEqual(["created", "updated", "updated"]);
  });
});

describe("VIP tiers and sanitization", () => {
  it("forces the tier from a unique email match and shows the relationship label", async () => {
    await store.updateSettings({ people: [{ name: "Priya Raman", relationship: "client", emails: ["priya@acme.example"] }] });
    const r = await store.upsertTask({
      ...newTask("Send deck", [gmail("m1", "T")]),
      task: { title: "Send deck", kind: "ask", signals: { requester_tier: "unknown" }, requester: { name: "P. Raman", email: "Priya@Acme.example" } },
    });
    const row = (await q<Record<string, unknown>>("SELECT requester_tier, requester_label, requester_name FROM tasks WHERE id = $1", [r.task_id]))[0]!;
    expect(row).toEqual({ requester_tier: "portfolio_ceo", requester_label: "client", requester_name: "Priya Raman" });
    expect(r.importance).toBe(4);
  });

  it("does not force a tier from an alias two people share", async () => {
    await store.updateSettings({
      people: [
        { name: "Arjun Mehta", relationship: "co-founder", aliases: ["AM"] },
        { name: "Anita Menon", relationship: "client", aliases: ["AM"] },
      ],
    });
    const r = await store.upsertTask({
      ...newTask("Review blog", [gmail("m1", "T")]),
      task: { title: "Review blog", kind: "ask", signals: { requester_tier: "external_counterparty" }, requester: { name: "AM" } },
    });
    const row = (await q<Record<string, unknown>>("SELECT requester_tier, requester_label FROM tasks WHERE id = $1", [r.task_id]))[0]!;
    expect(row).toEqual({ requester_tier: "external_counterparty", requester_label: null });
  });

  it("stores clean, capped text and only allowed links", async () => {
    const dirty = "<b>Please</b>​ send‮ the deck " + "x".repeat(400);
    const r = await store.upsertTask(
      newTask("Send deck", [
        gmail("m1", "T", { excerpt: dirty, url: "javascript:alert(1)" }),
        gcal("E1", { role: "evidence", url: "https://www.google.com/calendar/event?eid=abc" }),
        gmail("m9", "T9", { role: "evidence", url: "https://evil.example/mail" }),
      ]),
    );
    const rows = await q<{ item_key: string; excerpt: string | null; url: string | null; url_text: string | null }>(
      "SELECT item_key, excerpt, url, url_text FROM task_sources WHERE task_id = $1 ORDER BY item_key",
      [r.task_id],
    );
    const m1 = rows.find((x) => x.item_key === "m1")!;
    expect(Array.from(m1.excerpt!).length).toBeLessThanOrEqual(280);
    expect(m1.excerpt!.startsWith("Please send the deck")).toBe(true);
    expect(m1.excerpt).not.toMatch(/[<>​‮]/);
    expect(m1.url).toBeNull();
    expect(m1.url_text).toBe("javascript:alert(1)");
    expect(rows.find((x) => x.item_key === "E1")!.url).toBe("https://www.google.com/calendar/event?eid=abc");
    expect(rows.find((x) => x.item_key === "m9")!.url).toBeNull();
  });

  it("keeps excerpts and authors out of outcome and event rows", async () => {
    await store.upsertTask(newTask("Send deck", [gmail("m1", "T", { excerpt: "SECRET-EXCERPT-123", author: "Author-XYZ" })]));
    const dump = JSON.stringify([...(await q("SELECT * FROM ingest_outcomes")), ...(await q("SELECT * FROM task_events"))]);
    expect(dump).not.toContain("SECRET-EXCERPT-123");
    expect(dump).not.toContain("Author-XYZ");
  });
});
