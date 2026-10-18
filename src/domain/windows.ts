import type { Client, Pool } from "../db/pool.js";
import { businessDaysSince, localDate } from "./businessDays.js";
import { NotFoundError } from "./errors.js";
import { SOURCES, type RunCounts, type RunMode, type Source } from "./inputs.js";
import { cleanText } from "./sanitize.js";

// Server-owned run windows (R2, R3). Claude never supplies timestamps or does date arithmetic.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const MIN_SLICE_HOURS = 6;
export const REFRESH_OVERLAP_MS = HOUR;
export const CALENDAR_DAYS = 7;
const OPEN_THREAD_KEY_CAP = 50;

export interface WindowConfig {
  backfillDays: number;
  sliceDays: number;
  timezone: string;
}

export interface SyncRow {
  source: Source;
  refresh_cursor: Date | null;
  backfill_anchor: Date | null;
  backfill_next_to: Date | null;
  slices_done: number;
  current_slice_hours: number | null;
  refresh_window_hours: number | null;
  backfill_complete: boolean;
  last_run_at: Date | null;
  last_success_at: Date | null;
  last_status: "ok" | "partial" | "failed" | null;
  last_error: string | null;
}

const ms = (d: Date) => d.getTime();
const at = (n: number) => new Date(n);

/** Next backfill slice: newest first, stepping back from the anchor until BACKFILL_DAYS are covered. */
export function planBackfill(s: SyncRow, now: Date, cfg: WindowConfig) {
  const anchor = s.backfill_anchor ?? now;
  const sliceHours = s.current_slice_hours ?? cfg.sliceDays * 24;
  const floor = ms(anchor) - cfg.backfillDays * DAY;
  const to = s.backfill_next_to ? ms(s.backfill_next_to) : ms(anchor);
  const from = Math.max(to - sliceHours * HOUR, floor);
  return { anchor, from: at(from), to: at(to), isLast: from <= floor, sliceHours };
}

/** Refresh: from 1 h before the cursor to now, or a chunk of it while catching up after a capped refresh. */
export function planRefresh(s: SyncRow, now: Date) {
  const cursor = s.refresh_cursor ? ms(s.refresh_cursor) : ms(now) - DAY;
  const from = cursor - REFRESH_OVERLAP_MS;
  const to = s.refresh_window_hours ? Math.min(ms(now), from + s.refresh_window_hours * HOUR) : ms(now);
  return { from: at(from), to: at(Math.max(to, from + 1)) };
}

/** Calendar always reads now → now + 7 days, in every mode. */
export function planCalendar(now: Date) {
  return { from: now, to: at(ms(now) + CALENDAR_DAYS * DAY) };
}

export function estimateTotalSlices(s: SyncRow, cfg: WindowConfig): number {
  if (s.source === "gcal") return 1;
  if (s.backfill_complete) return s.slices_done;
  const anchor = s.backfill_anchor ? ms(s.backfill_anchor) : 0;
  const floor = anchor - cfg.backfillDays * DAY;
  const to = s.backfill_next_to ? ms(s.backfill_next_to) : anchor;
  const sliceHours = s.current_slice_hours ?? cfg.sliceDays * 24;
  const remaining = s.backfill_anchor ? Math.max(0, to - floor) : cfg.backfillDays * DAY;
  return s.slices_done + Math.max(1, Math.ceil(remaining / (sliceHours * HOUR)));
}

const epoch = (d: Date, round: "floor" | "ceil") => (round === "floor" ? Math.floor(ms(d) / 1000) : Math.ceil(ms(d) / 1000));
const ymd = (d: Date, tz: string, sep = "-") => localDate(d, tz).replaceAll("-", sep);

/** Ready-made query fragments. Rule: widen, never narrow; the guard absorbs anything read twice. */
export function queryHints(source: Source, mode: RunMode, from: Date, to: Date, isLast: boolean, tz: string): Record<string, string> {
  const dayBefore = at(ms(from) - DAY);
  const dayAfter = at(ms(to) + DAY);
  switch (source) {
    case "gmail": {
      const hints: Record<string, string> = {
        window: `after:${epoch(from, "floor")} before:${epoch(to, "ceil")}`,
        window_by_date: `after:${ymd(dayBefore, tz, "/")} before:${ymd(dayAfter, tz, "/")}`,
      };
      if (mode === "refresh" || isLast) {
        hints.sent_awaiting_reply = `in:sent after:${epoch(at(ms(to) - 30 * DAY), "floor")} before:${epoch(at(ms(to) - 3 * DAY), "ceil")}`;
      }
      if (mode === "refresh") hints.own_replies_since_window_start = `in:sent after:${epoch(from, "floor")}`;
      return hints;
    }
    case "slack": {
      const hints: Record<string, string> = { window: `after:${ymd(dayBefore, tz)} before:${ymd(dayAfter, tz)}` };
      if (mode === "refresh") hints.own_replies_since_window_start = `from:me after:${ymd(dayBefore, tz)}`;
      return hints;
    }
    case "gcal":
      return { time_min: from.toISOString(), time_max: to.toISOString() };
    case "granola":
      return { from_date: ymd(dayBefore, tz), to_date: ymd(dayAfter, tz) };
  }
}

const SYNC_COLUMNS = `source, refresh_cursor, backfill_anchor, backfill_next_to, slices_done, current_slice_hours,
  refresh_window_hours, backfill_complete, last_run_at, last_success_at, last_status, last_error`;

export async function ensureSyncRows(c: Pool | Client, userId: string): Promise<void> {
  await c.query(
    `INSERT INTO sync_state (user_id, source) SELECT $1, s FROM unnest($2::text[]) AS s ON CONFLICT DO NOTHING`,
    [userId, [...SOURCES]],
  );
}

export async function loadSync(c: Pool | Client, userId: string, source: Source): Promise<SyncRow> {
  await ensureSyncRows(c, userId);
  const { rows } = await c.query<SyncRow>(`SELECT ${SYNC_COLUMNS} FROM sync_state WHERE user_id = $1 AND source = $2`, [userId, source]);
  return rows[0]!;
}

export type StartRunResult =
  | {
      status: "started";
      run_id: string;
      mode: RunMode;
      source: Source;
      window_from: string;
      window_to: string;
      is_last_slice: boolean;
      slice: { number: number; estimated_total: number } | null;
      query_hints: Record<string, string>;
    }
  | { status: "backfill_incomplete" | "backfill_complete"; source: Source; message: string };

export async function startRun(c: Client, userId: string, mode: RunMode, source: Source, now: Date, cfg: WindowConfig): Promise<StartRunResult> {
  const s = await loadSync(c, userId, source);
  if (mode === "refresh" && !s.backfill_complete) {
    return { status: "backfill_incomplete", source, message: `${source} backfill is not complete; refresh skips this source` };
  }
  if (mode === "backfill" && s.backfill_complete) {
    return { status: "backfill_complete", source, message: `${source} backfill is already complete` };
  }

  let from: Date;
  let to: Date;
  let isLast = false;
  let slice: { number: number; estimated_total: number } | null = null;
  if (source === "gcal") {
    ({ from, to } = planCalendar(now));
    isLast = mode === "backfill";
    if (mode === "backfill") slice = { number: 1, estimated_total: 1 };
  } else if (mode === "backfill") {
    const plan = planBackfill(s, now, cfg);
    ({ from, to, isLast } = plan);
    if (!s.backfill_anchor) {
      // First backfill run: fix the anchor. The refresh cursor sits at the anchor until backfill completes.
      await c.query(
        `UPDATE sync_state SET backfill_anchor = $3, backfill_next_to = $3, current_slice_hours = $4, refresh_cursor = $3
         WHERE user_id = $1 AND source = $2`,
        [userId, source, plan.anchor, plan.sliceHours],
      );
      s.backfill_anchor = plan.anchor;
      s.backfill_next_to = plan.anchor;
      s.current_slice_hours = plan.sliceHours;
    }
    slice = { number: s.slices_done + 1, estimated_total: estimateTotalSlices(s, cfg) };
  } else {
    ({ from, to } = planRefresh(s, now));
  }

  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO ingest_runs (user_id, source, mode, window_from, window_to, is_last_slice, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [userId, source, mode, from, to, isLast, now],
  );
  await c.query("UPDATE sync_state SET last_run_at = $3 WHERE user_id = $1 AND source = $2", [userId, source, now]);
  return {
    status: "started",
    run_id: rows[0]!.id,
    mode,
    source,
    window_from: from.toISOString(),
    window_to: to.toISOString(),
    is_last_slice: isLast,
    slice,
    query_hints: queryHints(source, mode, from, to, isLast, cfg.timezone),
  };
}

interface RunRow {
  id: string;
  source: Source;
  mode: RunMode;
  window_from: Date;
  window_to: Date;
  is_last_slice: boolean;
  status: string;
}

export interface FinishRunResult {
  run_id: string;
  source: Source;
  status: "ok" | "partial" | "failed";
  already_finished?: true;
  cursor_advanced: boolean;
  slice_counted: boolean;
  capped: boolean;
  backfill_complete: boolean;
  slices_done: number;
  estimated_total_slices: number;
  message: string;
}

export async function finishRun(
  c: Client,
  userId: string,
  runId: string,
  status: "ok" | "partial" | "failed",
  counts: RunCounts,
  error: string | undefined,
  now: Date,
  cfg: WindowConfig,
): Promise<FinishRunResult> {
  const { rows } = await c.query<RunRow>(
    "SELECT id, source, mode, window_from, window_to, is_last_slice, status FROM ingest_runs WHERE id = $1 AND user_id = $2",
    [runId, userId],
  );
  const run = rows[0];
  if (!run) throw new NotFoundError("run");
  const s = await loadSync(c, userId, run.source);
  const summary = (over: Partial<FinishRunResult>, message: string): FinishRunResult => ({
    run_id: run.id,
    source: run.source,
    status,
    cursor_advanced: false,
    slice_counted: false,
    capped: !!counts.capped,
    backfill_complete: s.backfill_complete,
    slices_done: s.slices_done,
    estimated_total_slices: estimateTotalSlices(s, cfg),
    ...over,
    message,
  });
  if (run.status !== "running") {
    return summary({ status: run.status as FinishRunResult["status"], already_finished: true, capped: false }, "run was already finished; nothing changed");
  }

  const err = cleanText(error, 300);
  await c.query("UPDATE ingest_runs SET status = $2, counts = $3, error = $4, finished_at = $5 WHERE id = $1", [
    run.id,
    status,
    JSON.stringify(counts),
    status === "ok" ? null : err,
    now,
  ]);
  if (status !== "ok") {
    await c.query("UPDATE sync_state SET last_status = $3, last_error = $4 WHERE user_id = $1 AND source = $2", [
      userId,
      run.source,
      status,
      err ?? `${status} run`,
    ]);
    return summary({}, "window unchanged; the next run repeats it");
  }

  const runHours = Math.max(1, Math.round((ms(run.window_to) - ms(run.window_from)) / HOUR));
  const halved = Math.max(MIN_SLICE_HOURS, Math.floor(runHours / 2));
  const canHalve = !!counts.capped && runHours > MIN_SLICE_HOURS;
  const set: Partial<SyncRow> = { last_success_at: now, last_status: "ok", last_error: null };
  let advanced = false;
  let counted = false;
  let message: string;

  if (run.source === "gcal") {
    set.refresh_cursor = run.window_from;
    advanced = true;
    if (run.mode === "backfill") {
      set.backfill_complete = true;
      set.slices_done = 1;
      counted = true;
    }
    message = "calendar window recorded";
  } else if (run.mode === "backfill") {
    const expected = s.backfill_next_to && ms(s.backfill_next_to) === ms(run.window_to);
    if (!expected) {
      message = "this slice was superseded by a later run; nothing changed";
    } else if (canHalve) {
      set.current_slice_hours = halved;
      message = `slice capped; the next run covers it in ${halved}-hour slices`;
    } else {
      set.slices_done = s.slices_done + 1;
      set.backfill_next_to = run.window_from;
      counted = advanced = true;
      if (run.is_last_slice) set.backfill_complete = true;
      message = run.is_last_slice ? "backfill complete for this source" : "slice done; start a new chat for the next slice";
      if (counts.capped) message += " (capped at the minimum slice size; some older items may be missing)";
    }
  } else if (canHalve) {
    set.refresh_window_hours = halved;
    message = `refresh capped; the next refresh catches up in ${halved}-hour chunks`;
  } else {
    const cursor = Math.max(ms(run.window_to), s.refresh_cursor ? ms(s.refresh_cursor) : 0);
    set.refresh_cursor = at(cursor);
    advanced = true;
    const caughtUp = cursor >= ms(now) - REFRESH_OVERLAP_MS;
    if (caughtUp) set.refresh_window_hours = null;
    message = caughtUp ? "refresh window recorded" : "caught up to the end of this chunk; run refresh again to continue";
  }

  const cols = Object.keys(set);
  await c.query(
    `UPDATE sync_state SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(", ")} WHERE user_id = $1 AND source = $2`,
    [userId, run.source, ...cols.map((k) => set[k as keyof SyncRow])],
  );
  const after = { ...s, ...set } as SyncRow;
  return summary(
    {
      cursor_advanced: advanced,
      slice_counted: counted,
      backfill_complete: after.backfill_complete,
      slices_done: after.slices_done,
      estimated_total_slices: estimateTotalSlices(after, cfg),
    },
    message,
  );
}

/**
 * Puts a source back to its first backfill slice. With deleteTasks, removes that source's source rows
 * written by its backfill runs (and their outcome rows), then any task left with no origin or update source.
 */
export async function resetBackfill(c: Client, userId: string, source: Source, deleteTasks: boolean) {
  let deletedSources = 0;
  let deletedTasks = 0;
  if (deleteTasks) {
    const runs = (
      await c.query<{ id: string }>("SELECT id FROM ingest_runs WHERE user_id = $1 AND source = $2 AND mode = 'backfill'", [userId, source])
    ).rows.map((r) => r.id);
    if (runs.length) {
      deletedSources = (
        await c.query(
          `DELETE FROM task_sources ts USING tasks t
           WHERE ts.task_id = t.id AND t.user_id = $1 AND ts.source = $2 AND ts.run_id = ANY($3::uuid[])`,
          [userId, source, runs],
        )
      ).rowCount ?? 0;
      await c.query("DELETE FROM ingest_outcomes WHERE user_id = $1 AND run_id = ANY($2::uuid[])", [userId, runs]);
      await c.query("DELETE FROM ingest_runs WHERE user_id = $1 AND id = ANY($2::uuid[])", [userId, runs]);
    }
    deletedTasks = (
      await c.query(
        `DELETE FROM tasks t WHERE t.user_id = $1 AND NOT EXISTS (
           SELECT 1 FROM task_sources ts WHERE ts.task_id = t.id AND ts.role IN ('origin','update'))`,
        [userId],
      )
    ).rowCount ?? 0;
  }
  await ensureSyncRows(c, userId);
  await c.query(
    `UPDATE sync_state SET refresh_cursor = NULL, backfill_anchor = NULL, backfill_next_to = NULL, slices_done = 0,
       current_slice_hours = NULL, refresh_window_hours = NULL, backfill_complete = false,
       last_success_at = NULL, last_status = NULL, last_error = NULL
     WHERE user_id = $1 AND source = $2`,
    [userId, source],
  );
  return { source, deleted_sources: deletedSources, deleted_tasks: deletedTasks };
}

export interface SourceProgress {
  source: Source;
  backfill_complete: boolean;
  slices_done: number;
  estimated_total_slices: number;
  next_backfill_window: { from: string; to: string } | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_status: string | null;
  last_error: string | null;
  stale: boolean;
}

/** Per-source progress plus the thread keys of open Gmail and Slack tasks (for the resolution pass). */
export async function syncStateView(db: Pool | Client, userId: string, now: Date, cfg: WindowConfig) {
  await ensureSyncRows(db, userId);
  const { rows } = await db.query<SyncRow>(`SELECT ${SYNC_COLUMNS} FROM sync_state WHERE user_id = $1`, [userId]);
  const bySource = new Map(rows.map((r) => [r.source, r]));
  const sources: SourceProgress[] = SOURCES.map((source) => {
    const s = bySource.get(source)!;
    const next = !s.backfill_complete && source !== "gcal" ? planBackfill(s, now, cfg) : null;
    return {
      source,
      backfill_complete: s.backfill_complete,
      slices_done: s.slices_done,
      estimated_total_slices: estimateTotalSlices(s, cfg),
      next_backfill_window: next ? { from: next.from.toISOString(), to: next.to.toISOString() } : null,
      last_run_at: s.last_run_at?.toISOString() ?? null,
      last_success_at: s.last_success_at?.toISOString() ?? null,
      last_status: s.last_status,
      last_error: s.last_error,
      stale: s.backfill_complete && (!s.last_success_at || businessDaysSince(s.last_success_at, now, cfg.timezone) > 1),
    };
  });
  const keys = await db.query<{ source: Source; thread_key: string }>(
    `SELECT source, thread_key FROM (
       SELECT ts.source, ts.thread_key, max(t.last_activity_at) AS last,
              row_number() OVER (PARTITION BY ts.source ORDER BY max(t.last_activity_at) DESC) AS rn
       FROM task_sources ts JOIN tasks t ON t.id = ts.task_id
       WHERE t.user_id = $1 AND t.status <> 'done' AND ts.source IN ('gmail','slack') AND ts.role IN ('origin','update')
       GROUP BY ts.source, ts.thread_key
     ) k WHERE rn <= $2 ORDER BY source, last DESC`,
    [userId, OPEN_THREAD_KEY_CAP],
  );
  const open_thread_keys: Record<"gmail" | "slack", string[]> = { gmail: [], slack: [] };
  for (const k of keys.rows) open_thread_keys[k.source as "gmail" | "slack"].push(k.thread_key);
  return {
    backfill_days: cfg.backfillDays,
    slice_days: cfg.sliceDays,
    sources,
    open_thread_keys,
  };
}
