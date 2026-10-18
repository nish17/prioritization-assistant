import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { wipe } from "../src/db/wipe.js";
import { createMcpServer } from "../src/mcp/createServer.js";
import { createApp } from "../src/server.js";
import type { Store } from "../src/domain/store.js";
import { gmail, makeStore, newTask, type Clock } from "./helpers/fixtures.js";
import { listen, type Running } from "./helpers/http.js";
import { freshDb, type TestDb } from "./helpers/pg.js";

const SECRET = "c".repeat(64);
let db: TestDb;
let srv: Running;
let store: Store;
let client: Client;
const clock: Clock = { now: new Date("2026-10-18T10:00:00Z") };

beforeAll(async () => {
  db = await freshDb();
  store = makeStore(db, clock);
  srv = await listen(createApp({ authMode: "path", secret: SECRET, makeServer: () => createMcpServer({ store }) }));
  client = new Client({ name: "tools-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/${SECRET}`)));
});
afterAll(async () => {
  await client.close();
  await srv.close();
  await db.drop();
});
beforeEach(async () => {
  await wipe(db.pool);
});

type Result = { structuredContent?: Record<string, unknown>; content: { type: string; text: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
const taskCount = async () => Number((await db.pool.query("SELECT count(*) AS n FROM tasks")).rows[0].n);

describe("tool surface", () => {
  it("lists 11 titled tools with explicit annotations and small, flat schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["find_related", "finish_run", "get_settings", "get_sync_state", "get_task", "list_tasks", "reset_backfill", "start_run", "update_settings", "update_status", "upsert_task"].sort(),
    );
    const writes = ["start_run", "finish_run", "upsert_task", "update_status", "update_settings"];
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      const schema = JSON.stringify(t.inputSchema);
      expect(schema.length, t.name).toBeLessThan(16_384);
      expect(t.inputSchema.type).toBe("object");
      for (const key of ["anyOf", "oneOf", "allOf"]) expect(t.inputSchema, t.name).not.toHaveProperty(key);
      expect(schema, t.name).not.toContain("$ref");
      if (writes.includes(t.name)) expect(t.annotations, t.name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      else if (t.name === "reset_backfill") expect(t.annotations).toMatchObject({ destructiveHint: true });
      else expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true });
    }
    expect(tools.find((t) => t.name === "update_status")!.annotations).toMatchObject({ idempotentHint: true });
    const board = tools.find((t) => t.name === "list_tasks")!;
    expect((board._meta as { ui: { resourceUri: string } }).ui.resourceUri).toMatch(/^ui:\/\/prioritizer\/board-/);
  });

  it("serves the board resource as an MCP App", async () => {
    const { tools } = await client.listTools();
    const uri = (tools.find((t) => t.name === "list_tasks")!._meta as { ui: { resourceUri: string } }).ui.resourceUri;
    const res = await client.readResource({ uri });
    expect(res.contents[0]).toMatchObject({ uri, mimeType: "text/html;profile=mcp-app" });
    expect(String((res.contents[0] as { text: string }).text)).toMatch(/<html|<!doctype/i);
  });
});

describe("tool calls", () => {
  it("returns outcome, quadrant and fired rules from upsert_task, and the matched title on conversion", async () => {
    const first = await call("upsert_task", newTask("Send Q4 deck", [gmail("m1", "T")]) as unknown as Record<string, unknown>);
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({ outcome: "created", quadrant: expect.any(String), rules_version: "2" });
    expect(first.structuredContent!.rules_fired).toEqual(expect.arrayContaining([expect.stringContaining("Waiting on you")]));
    expect(JSON.parse(first.content[0]!.text).task_id).toBe(first.structuredContent!.task_id);
    const second = await call("upsert_task", newTask("Add budget slide", [gmail("m2", "T", { occurred_at: "2026-10-17T12:00:00Z" })]) as unknown as Record<string, unknown>);
    expect(second.structuredContent).toMatchObject({ outcome: "converted", matched_title: "Send Q4 deck", task_id: first.structuredContent!.task_id });
  });

  it.each([
    ["25 sources", () => newTask("Too many", Array.from({ length: 25 }, (_, i) => gmail(`m${i}`, "T", { role: "evidence" }))), /sources/],
    ["an invalid enum", () => ({ ...newTask("Bad", [gmail("m1", "T")]), decision: "maybe" }), /decision/],
    ["a missing Gmail thread_key", () => newTask("No thread", [gmail("m1", "T", { thread_key: undefined })]), /thread_key/],
  ])("rejects %s with an error naming the field and no write", async (_label, build, field) => {
    const r = await call("upsert_task", build() as unknown as Record<string, unknown>);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(field);
    expect(await taskCount()).toBe(0);
  });

  it("advances the window only when finish_run reports ok", async () => {
    const a = (await call("start_run", { mode: "backfill", source: "gmail" })).structuredContent as { run_id: string; window_to: string };
    const partial = await call("finish_run", { run_id: a.run_id, status: "partial", counts: { fetched: 1, evaluated: 1, not_a_task: 0 } });
    expect(partial.structuredContent).toMatchObject({ cursor_advanced: false });
    const b = (await call("start_run", { mode: "backfill", source: "gmail" })).structuredContent as { run_id: string; window_to: string };
    expect(b.window_to).toBe(a.window_to);
    const done = await call("finish_run", { run_id: b.run_id, status: "ok", counts: { fetched: 1, evaluated: 1, not_a_task: 0 } });
    expect(done.structuredContent).toMatchObject({ cursor_advanced: true, slices_done: 1 });
  });

  it("returns a compact board for 500 open tasks quickly, with a text summary", async () => {
    const userId = await store.userId();
    await db.pool.query(
      `INSERT INTO tasks (user_id, title, title_norm, kind, rules_version, urgency_reason, importance_reason)
       SELECT $1, 'Task ' || g, 'task ' || g, 'ask', '2', repeat('u', 250), repeat('i', 250) FROM generate_series(1, 500) g`,
      [userId],
    );
    const started = Date.now();
    const r = await call("list_tasks");
    expect(Date.now() - started).toBeLessThan(2000);
    const size = JSON.stringify(r.structuredContent).length + r.content[0]!.text.length;
    expect(size).toBeLessThan(100_000);
    expect(r.content[0]!.text).toMatch(/DEFER \(neither\): 500/);
  });

  it("returns untrusted-labelled sources, entities, links and events from get_task", async () => {
    const a = await store.upsertTask({
      ...newTask("Send deck", [gmail("m1", "T", { excerpt: "Please send the deck" })]),
      entities: [{ type: "person", name: "Priya Raman", email: "priya@acme.example", role: "requester" }],
    });
    const b = await store.upsertTask(newTask("Book venue", [gmail("m2", "T", { occurred_at: "2026-10-17T13:00:00Z" })], { separate_task: true }));
    const r = await call("get_task", { task_id: a.task_id });
    const sc = r.structuredContent as { sources: Record<string, unknown>[]; entities: unknown[]; links: { task_id: string }[]; events: unknown[] };
    expect(sc.sources[0]).toMatchObject({ untrusted_excerpt: "Please send the deck" });
    expect(sc.entities).toEqual([{ type: "person", name: "Priya Raman", role: "requester" }]);
    expect(sc.links.map((l) => l.task_id)).toEqual([b.task_id]);
    expect(sc.events.length).toBeGreaterThan(0);
  });

  it("names snooze_until when snoozing without it", async () => {
    const t = await store.upsertTask(newTask("Send deck", [gmail("m1", "T")]));
    const r = await call("update_status", { task_id: t.task_id, status: "snoozed" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^snooze_until:/);
  });

  it("round-trips settings through update_settings and get_settings, with warnings", async () => {
    const r = await call("update_settings", { people: [{ name: "Priya", relationship: "client", emails: ["P@Acme.example"] }, { name: "Kim", relationship: "mentor" }] });
    expect(r.structuredContent!.warnings).toEqual([expect.stringContaining("Kim")]);
    const g = await call("get_settings");
    expect(g.structuredContent).toMatchObject({ timezone: "Asia/Kolkata", people: [expect.objectContaining({ emails: ["p@acme.example"], tier: "portfolio_ceo" }), expect.anything()] });
  });

  it("returns sync state, related tasks and resets a backfill through MCP", async () => {
    const run = (await call("start_run", { mode: "backfill", source: "gmail" })).structuredContent as { run_id: string };
    await store.upsertTask(newTask("Send Q4 deck", [gmail("m1", "T")], { run_id: run.run_id }));
    const sync = (await call("get_sync_state")).structuredContent as { sources: { source: string }[]; open_thread_keys: { gmail: string[] } };
    expect(sync.sources.map((x) => x.source)).toEqual(["gmail", "slack", "gcal", "granola"]);
    expect(sync.open_thread_keys.gmail).toEqual(["T"]);
    const related = (await call("find_related", { thread_keys: [{ source: "gmail", thread_key: "T" }], keywords: ["q4 deck"] })).structuredContent as { candidates: { match_reasons: string[] }[] };
    expect(related.candidates[0]!.match_reasons).toEqual(expect.arrayContaining(["same thread"]));
    const reset = await call("reset_backfill", { source: "gmail", delete_tasks: true });
    expect(reset.structuredContent).toMatchObject({ source: "gmail", deleted_tasks: 1 });
    expect(await taskCount()).toBe(0);
  });

  it("reports an unknown task as a fixable error", async () => {
    const r = await call("get_task", { task_id: "00000000-0000-4000-8000-000000000000" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("task not found");
  });
});

describe("log hygiene", () => {
  const captured: string[] = [];
  afterEach(() => vi.restoreAllMocks());

  it("never logs excerpts, authors or the secret", async () => {
    const capture = (...args: unknown[]) => void captured.push(args.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    await call("upsert_task", newTask("Send deck", [gmail("m1", "T", { excerpt: "EXCERPT-SENTINEL-42", author: "AUTHOR-SENTINEL" })]) as unknown as Record<string, unknown>);
    await call("upsert_task", newTask("Bad", [gmail("m2", "T", { thread_key: undefined, excerpt: "EXCERPT-SENTINEL-43" })]) as unknown as Record<string, unknown>);
    const all = captured.join("\n");
    expect(captured.some((l) => l.includes('"name":"upsert_task"'))).toBe(true);
    for (const s of ["EXCERPT-SENTINEL", "AUTHOR-SENTINEL", SECRET]) expect(all).not.toContain(s);
  });
});
