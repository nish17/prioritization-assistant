import { Store } from "../../src/domain/store.js";
import type { SourceRefInput, UpsertTaskInput } from "../../src/domain/inputs.js";
import type { TestDb } from "./pg.js";

export interface Clock {
  now: Date;
}

export function makeStore(db: TestDb, clock: Clock, over: { backfillDays?: number; sliceDays?: number } = {}) {
  return new Store({
    pool: db.pool,
    userEmail: "jeevan@example.com",
    userName: "Jeevan",
    timezone: "Asia/Kolkata",
    backfillDays: over.backfillDays ?? 30,
    sliceDays: over.sliceDays ?? 7,
    clock: () => clock.now,
  });
}

export const gmail = (message: string, thread: string, over: Partial<SourceRefInput> = {}): SourceRefInput => ({
  source: "gmail",
  external_id: message,
  thread_key: thread,
  role: "origin",
  occurred_at: "2026-10-17T10:00:00Z",
  title: `Subject of ${thread}`,
  url: `https://mail.google.com/mail/u/0/#all/${thread}`,
  author: "Priya Raman",
  excerpt: "Could you send the deck?",
  ...over,
});

export const gcal = (instance: string, over: Partial<SourceRefInput> = {}): SourceRefInput => ({
  source: "gcal",
  external_id: instance,
  role: "origin",
  occurred_at: "2026-10-17T09:00:00Z",
  title: "Acme weekly sync",
  ...over,
});

export const granola = (meeting: string, askIndex: number, over: Partial<SourceRefInput> = {}): SourceRefInput => ({
  source: "granola",
  external_id: meeting,
  ask_index: askIndex,
  role: "origin",
  occurred_at: "2026-10-17T11:00:00Z",
  title: "Acme sync notes",
  ...over,
});

export function newTask(title: string, sources: SourceRefInput[], over: Partial<UpsertTaskInput> = {}, signals: Record<string, unknown> = {}): UpsertTaskInput {
  return {
    decision: "new",
    task: { title, kind: "ask", signals: { waiting_on_user: true, ask_received_at: sources[0]?.occurred_at, ...signals } },
    sources,
    ...over,
  } as UpsertTaskInput;
}

export function updateTask(taskId: string, sources: SourceRefInput[], signals: Record<string, unknown> = {}, over: Partial<UpsertTaskInput> = {}): UpsertTaskInput {
  return { decision: "update", task_id: taskId, task: { signals }, sources, ...over } as UpsertTaskInput;
}
