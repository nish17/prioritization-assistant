import type { Client } from "../db/pool.js";
import { zonedDateTime } from "./businessDays.js";
import { NotFoundError, ValidationError } from "./errors.js";
import type { Source, SourceRole, UpsertTaskInput } from "./inputs.js";
import { cleanText, cleanUrl, LIMITS, normalizeTitle } from "./sanitize.js";
import type { TaskStatus } from "./scoring.js";
import { DEFAULT_SCORING, type RequesterTier } from "./scoringConfig.js";
import { matchPerson, type Person } from "./settings.js";
import { TASK_COLUMNS, type TaskRow } from "./taskRow.js";

// The write-side guard (R7, R8). Runs inside withUserLock: one transaction, one client, per-user lock.
//
// Step 1 (item):   the request's single origin/update item already stored → idempotent update, or
//                  skipped-done on a done task. A known external_id with a new ask_index in a later run
//                  (Claude renumbered on a re-read) converts instead of creating.
// Step 2 (thread): a new item in a thread that has an open task → sibling ask (same external_id) creates a
//                  linked task; a later message converts into the most recently active match.
// separate_task skips Step 2 and the drift rule, and moves an item that was attached only by a conversion.
// A re-read of any stored item (origin, update, evidence or resolution) never creates a task.

export type Outcome = "created" | "updated" | "converted" | "skipped-done" | "evidence" | "reopened" | "moved";

export interface UpsertContext {
  userId: string;
  now: Date;
  timezone: string;
  people: Person[];
}

export interface UpsertResult {
  task_id: string;
  outcome: Outcome;
  status: TaskStatus;
  converted?: true;
  matched_title?: string;
  existing_asks?: { ask_index: number | null; task_id: string; title: string; status: TaskStatus }[];
  skipped?: true;
  linked_to?: string[];
}

interface PreparedSource {
  source: Source;
  external_id: string;
  ask_index: number | null;
  item_key: string;
  thread_key: string;
  role: SourceRole;
  occurred_at: Date;
  title: string | null;
  url: string | null;
  url_text: string | null;
  author: string | null;
  excerpt: string | null;
}

/** Signal and text fields as they will be written; undefined means "not supplied". */
interface PreparedFields {
  title?: string;
  summary?: string | null;
  kind?: string;
  workstream?: string | null;
  due_at?: Date | null;
  due_confidence?: "explicit" | "inferred" | "none";
  waiting_on_user?: boolean;
  ask_received_at?: Date | null;
  requester_tier?: RequesterTier | null;
  requester_name?: string | null;
  requester_label?: string | null;
  risk_flags?: string[];
  urgency_language?: boolean;
  delegable?: boolean;
  suggested_delegate?: string | null;
  claude_importance?: number | null;
  urgency_reason?: string | null;
  importance_reason?: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NO_RUN_BURST_MS = 30 * 60_000;
const LOOKS_LIKE_URL = /^[a-z][a-z0-9+.-]*:\/\/|^www\./i;
const SLACK_KEY = /^[^\s:]+:[^\s:]+$/;

function checkKey(value: string, field: string, source: Source): string {
  const v = value.trim();
  if (!v || /\s/.test(v) || LOOKS_LIKE_URL.test(v)) throw new ValidationError(field, "must be the connector's ID, not a URL or free text");
  if (source === "slack" && !SLACK_KEY.test(v)) throw new ValidationError(field, "must be channel:ts for Slack");
  return v;
}

function prepareSources(input: UpsertTaskInput): { primary: PreparedSource | undefined; others: PreparedSource[] } {
  const seen = new Set<string>();
  const all: PreparedSource[] = [];
  input.sources.forEach((s, i) => {
    const external_id = checkKey(s.external_id, `sources[${i}].external_id`, s.source);
    let thread_key: string;
    if (s.source === "gcal" || s.source === "granola") {
      thread_key = external_id; // each meeting instance is its own thread
    } else {
      if (!s.thread_key) {
        throw new ValidationError(`sources[${i}].thread_key`, "required for gmail and slack (Gmail thread ID, or Slack channel:thread_ts)");
      }
      thread_key = checkKey(s.thread_key, `sources[${i}].thread_key`, s.source);
    }
    const ask_index = s.ask_index ?? null;
    const item_key = ask_index === null ? external_id : `${external_id}#${ask_index}`;
    const dupKey = `${s.source}|${item_key}`;
    if (seen.has(dupKey)) return;
    seen.add(dupKey);
    all.push({
      source: s.source,
      external_id,
      ask_index,
      item_key,
      thread_key,
      role: s.role,
      occurred_at: new Date(s.occurred_at),
      title: cleanText(s.title, LIMITS.sourceTitle),
      ...cleanUrl(s.url),
      author: cleanText(s.author, LIMITS.author),
      excerpt: cleanText(s.excerpt, LIMITS.excerpt),
    });
  });
  const primaries = all.filter((s) => s.role === "origin" || s.role === "update");
  if (primaries.length > 1) {
    throw new ValidationError("sources", "at most one origin or update source per call; mark the others as evidence");
  }
  if (input.decision === "new" && primaries.length === 0) throw new ValidationError("sources", "decision=new needs one origin source");
  const primary = primaries[0];
  if (primary) primary.role = input.decision === "new" ? "origin" : "update";
  return { primary, others: all.filter((s) => s !== primary) };
}

function prepareFields(input: UpsertTaskInput, ctx: UpsertContext): PreparedFields {
  const t = input.task;
  const sig = t.signals ?? {};
  const f: PreparedFields = {};
  if (t.title !== undefined) {
    const title = cleanText(t.title, LIMITS.title);
    if (title) f.title = title;
  }
  if (t.summary !== undefined) f.summary = cleanText(t.summary, LIMITS.summary);
  if (t.kind !== undefined) f.kind = t.kind;
  if (t.workstream !== undefined) f.workstream = cleanText(t.workstream, LIMITS.workstream);
  if (sig.due_at !== undefined) {
    f.due_at = sig.due_at === null ? null : ISO_DATE.test(sig.due_at) ? zonedDateTime(sig.due_at, 18, ctx.timezone) : new Date(sig.due_at);
  }
  if (sig.due_confidence !== undefined) f.due_confidence = sig.due_confidence;
  if (f.due_at && f.due_confidence === undefined) f.due_confidence = "inferred";
  if (f.due_at === null) f.due_confidence = "none";
  if (sig.waiting_on_user !== undefined) f.waiting_on_user = sig.waiting_on_user;
  if (sig.ask_received_at !== undefined) f.ask_received_at = sig.ask_received_at === null ? null : new Date(sig.ask_received_at);
  if (sig.requester_tier !== undefined) f.requester_tier = sig.requester_tier;
  if (sig.risk_flags !== undefined) f.risk_flags = [...new Set(sig.risk_flags)];
  if (sig.urgency_language !== undefined) f.urgency_language = sig.urgency_language;
  if (sig.delegable !== undefined) f.delegable = sig.delegable;
  if (sig.suggested_delegate !== undefined) f.suggested_delegate = cleanText(sig.suggested_delegate, LIMITS.name);
  if (sig.claude_importance !== undefined) f.claude_importance = Math.min(2, Math.max(0, Math.round(sig.claude_importance)));
  if (t.urgency_reason !== undefined) f.urgency_reason = cleanText(t.urgency_reason, LIMITS.reason);
  if (t.importance_reason !== undefined) f.importance_reason = cleanText(t.importance_reason, LIMITS.reason);

  // R11: a unique match on saved people forces the tier and the user's own relationship label.
  const r = t.requester;
  if (r) {
    const person = matchPerson(ctx.people, r);
    if (person) {
      f.requester_tier = person.tier;
      f.requester_name = person.name;
      f.requester_label = person.relationship;
    } else if (r.name !== undefined) {
      f.requester_name = cleanText(r.name, LIMITS.name);
      f.requester_label = null;
    }
  }
  return f;
}

const tierWeight = (t: RequesterTier | null | undefined) => (t ? DEFAULT_SCORING.importance.tiers[t] : -1);

async function loadTask(c: Client, userId: string, taskId: string): Promise<TaskRow | undefined> {
  const { rows } = await c.query<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = $1 AND t.user_id = $2`, [taskId, userId]);
  return rows[0];
}

async function attachSource(c: Client, taskId: string, s: PreparedSource, runId: string | null, role: SourceRole, viaConversion = false) {
  await c.query(
    `INSERT INTO task_sources (task_id, source, external_id, ask_index, item_key, thread_key, role, via_conversion,
       title, url, url_text, occurred_at, author, excerpt, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (task_id, source, item_key) DO NOTHING`,
    [taskId, s.source, s.external_id, s.ask_index, s.item_key, s.thread_key, role, viaConversion, s.title, s.url, s.url_text, s.occurred_at, s.author, s.excerpt, runId],
  );
}

async function link(c: Client, from: string, to: string, type = "related") {
  if (from === to) return;
  await c.query("INSERT INTO task_links (from_task_id, to_task_id, link_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [from, to, type]);
}

async function event(c: Client, taskId: string, type: string) {
  await c.query("INSERT INTO task_events (task_id, actor, event_type) VALUES ($1, 'claude', $2)", [taskId, type]);
}

async function resolveEntities(c: Client, userId: string, taskId: string, input: UpsertTaskInput) {
  for (const e of input.entities ?? []) {
    const name = cleanText(e.name, LIMITS.name);
    if (!name) continue;
    const email = e.email?.trim().toLowerCase() || null;
    let id: string | undefined;
    if (email && e.type === "person") {
      id = (await c.query<{ id: string }>("SELECT id FROM entities WHERE user_id = $1 AND type = 'person' AND emails @> ARRAY[$2]::text[] LIMIT 1", [userId, email])).rows[0]?.id;
    }
    if (!id) {
      id = (
        await c.query<{ id: string }>(
          `INSERT INTO entities (user_id, type, canonical_name, emails) VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, type, lower(canonical_name))
           DO UPDATE SET emails = (SELECT array_agg(DISTINCT x) FROM unnest(entities.emails || EXCLUDED.emails) AS x)
           RETURNING id`,
          [userId, e.type, name, email ? [email] : []],
        )
      ).rows[0]!.id;
    }
    await c.query("INSERT INTO task_entities (task_id, entity_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [taskId, id, e.role ?? null]);
  }
}

async function explicitLinks(c: Client, userId: string, taskId: string, input: UpsertTaskInput): Promise<string[]> {
  const wanted = (input.link_to ?? []).filter((l) => l.task_id !== taskId);
  if (!wanted.length) return [];
  const ids = wanted.map((l) => l.task_id);
  const found = new Set(
    (await c.query<{ id: string }>("SELECT id FROM tasks WHERE user_id = $1 AND id = ANY($2::uuid[])", [userId, ids])).rows.map((r) => r.id),
  );
  for (const l of wanted) {
    if (!found.has(l.task_id)) throw new ValidationError("link_to", `unknown task_id ${l.task_id}`);
    await link(c, taskId, l.task_id, l.link_type);
  }
  return ids;
}

async function recordOutcome(c: Client, ctx: UpsertContext, runId: string | null, s: PreparedSource, outcome: Outcome, taskId: string) {
  await c.query(
    "INSERT INTO ingest_outcomes (user_id, run_id, source, external_id, item_key, outcome, task_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [ctx.userId, runId, s.source, s.external_id, s.item_key, outcome, taskId, ctx.now],
  );
}

async function createTask(c: Client, ctx: UpsertContext, input: UpsertTaskInput, f: PreparedFields, p: PreparedSource, others: PreparedSource[], runId: string | null, linkTo: string[]) {
  if (!f.title) throw new ValidationError("task.title", "required for decision=new");
  if (!f.kind) throw new ValidationError("task.kind", "required for decision=new");
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO tasks (user_id, title, title_norm, summary, kind, workstream, due_at, due_confidence, waiting_on_user,
       ask_received_at, requester_tier, requester_name, requester_label, risk_flags, urgency_language, delegable,
       suggested_delegate, claude_importance, urgency_reason, importance_reason, rules_version, created_run_id,
       first_seen_at, last_activity_at, status_changed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$23,$23)
     RETURNING id`,
    [
      ctx.userId,
      f.title,
      normalizeTitle(f.title),
      f.summary ?? null,
      f.kind,
      f.workstream ?? null,
      f.due_at ?? null,
      f.due_confidence ?? "none",
      f.waiting_on_user ?? false,
      f.ask_received_at ?? null,
      f.requester_tier ?? null,
      f.requester_name ?? null,
      f.requester_label ?? null,
      f.risk_flags ?? [],
      f.urgency_language ?? false,
      f.delegable ?? false,
      f.suggested_delegate ?? null,
      f.claude_importance ?? null,
      f.urgency_reason ?? null,
      f.importance_reason ?? null,
      DEFAULT_SCORING.rules_version,
      runId,
      ctx.now,
      p.occurred_at,
    ],
  );
  const taskId = rows[0]!.id;
  await attachSource(c, taskId, p, runId, "origin");
  for (const o of others) await attachSource(c, taskId, o, runId, o.role);
  for (const id of linkTo) await link(c, taskId, id);
  const explicit = await explicitLinks(c, ctx.userId, taskId, input);
  await resolveEntities(c, ctx.userId, taskId, input);
  await event(c, taskId, "created");
  return { taskId, linked: [...new Set([...linkTo, ...explicit])] };
}

/**
 * Applies an origin/update item to an existing non-done task. Newer wins, older never overwrites:
 * the title is kept, risk flags are unioned, an explicit due date is never replaced by an inferred one or by none,
 * the requester never downgrades, and other signals change only when the item is newer than the task's latest
 * origin/update source. Returns whether the reopen rule fired.
 */
async function applyToTask(
  c: Client,
  ctx: UpsertContext,
  input: UpsertTaskInput,
  task: TaskRow,
  f: PreparedFields,
  p: PreparedSource | undefined,
  others: PreparedSource[],
  runId: string | null,
  viaConversion: boolean,
): Promise<{ reopened: boolean }> {
  const latest = (
    await c.query<{ latest: Date | null }>("SELECT max(occurred_at) AS latest FROM task_sources WHERE task_id = $1 AND role IN ('origin','update')", [task.id])
  ).rows[0]?.latest;
  const newer = !!p && (!latest || p.occurred_at.getTime() > latest.getTime());

  const set: Record<string, unknown> = {};
  if (f.risk_flags?.length) set.risk_flags = [...new Set([...task.risk_flags, ...f.risk_flags])];
  if (newer) {
    if (f.due_at && (task.due_confidence !== "explicit" || f.due_confidence === "explicit")) {
      set.due_at = f.due_at;
      set.due_confidence = f.due_confidence ?? "inferred";
    }
    for (const k of ["summary", "workstream", "waiting_on_user", "ask_received_at", "urgency_language", "delegable", "suggested_delegate", "claude_importance", "urgency_reason", "importance_reason"] as const) {
      if (f[k] !== undefined && f[k] !== null) set[k] = f[k];
    }
    if (f.requester_tier !== undefined && tierWeight(f.requester_tier) >= tierWeight(task.requester_tier)) {
      set.requester_tier = f.requester_tier;
      if (f.requester_name !== undefined) set.requester_name = f.requester_name;
      if (f.requester_label !== undefined) set.requester_label = f.requester_label;
    }
  }
  if (p && p.occurred_at.getTime() > task.last_activity_at.getTime()) set.last_activity_at = p.occurred_at;

  // Reopen: a newer ask lands on a snoozed, waiting or delegated task.
  const reopened =
    !!p &&
    (task.status === "snoozed" || task.status === "waiting_on_others" || task.status === "delegated") &&
    p.occurred_at.getTime() > task.status_changed_at.getTime() &&
    f.waiting_on_user === true;
  if (reopened) {
    Object.assign(set, { status: "open", snooze_until: null, follow_up_at: null, delegated_to: null, status_changed_at: ctx.now });
  }
  set.rules_version = DEFAULT_SCORING.rules_version;
  set.updated_at = ctx.now;

  const cols = Object.keys(set);
  await c.query(`UPDATE tasks SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [task.id, ...cols.map((k) => set[k])]);
  if (p) await attachSource(c, task.id, p, runId, "update", viaConversion);
  for (const o of others) await attachSource(c, task.id, o, runId, o.role);
  await explicitLinks(c, ctx.userId, task.id, input);
  await resolveEntities(c, ctx.userId, task.id, input);
  await event(c, task.id, reopened ? "reopened" : viaConversion ? "converted" : "updated");
  return { reopened };
}

async function attachAsEvidence(c: Client, taskId: string, sources: PreparedSource[], runId: string | null) {
  for (const s of sources) await attachSource(c, taskId, s, runId, s.role === "resolution" ? "resolution" : "evidence");
  await event(c, taskId, "evidence_added");
}

export async function upsertTask(c: Client, input: UpsertTaskInput, ctx: UpsertContext): Promise<UpsertResult> {
  const { primary, others } = prepareSources(input);
  const f = prepareFields(input, ctx);
  let runId = input.run_id ?? null;
  if (runId) {
    const run = (
      await c.query<{ source: Source; status: string }>("SELECT source, status FROM ingest_runs WHERE id = $1 AND user_id = $2", [runId, ctx.userId])
    ).rows[0];
    if (!run) throw new ValidationError("run_id", "unknown run");
    // Only an open run of the item's own source owns what it writes; anything else (a finished run reused later,
    // another source's run) is treated as no run, so reset_backfill never deletes or misses rows because of it.
    if (run.status !== "running" || (primary && primary.source !== run.source)) runId = null;
  }

  if (input.decision === "update") {
    if (!input.task_id) throw new ValidationError("task_id", "required for decision=update");
    const task = await loadTask(c, ctx.userId, input.task_id);
    if (!task) throw new NotFoundError("task");
    const keySource = primary ?? others[0]!;
    if (task.status === "done") {
      await attachAsEvidence(c, task.id, primary ? [primary, ...others] : others, runId);
      await recordOutcome(c, ctx, runId, keySource, "evidence", task.id);
      return { task_id: task.id, outcome: "evidence", status: "done", skipped: true };
    }
    if (!primary) {
      await attachAsEvidence(c, task.id, others, runId);
      await explicitLinks(c, ctx.userId, task.id, input);
      await resolveEntities(c, ctx.userId, task.id, input);
      await recordOutcome(c, ctx, runId, keySource, "evidence", task.id);
      return { task_id: task.id, outcome: "evidence", status: task.status };
    }
    const elsewhere = (
      await c.query<{ task_id: string; title: string }>(
        `SELECT ts.task_id, t.title FROM task_sources ts JOIN tasks t ON t.id = ts.task_id
         WHERE t.user_id = $1 AND ts.source = $2 AND ts.item_key = $3 AND ts.role IN ('origin','update')
           AND ts.task_id <> $4 AND t.status <> 'done' LIMIT 1`,
        [ctx.userId, primary.source, primary.item_key, task.id],
      )
    ).rows[0];
    if (elsewhere) {
      throw new ValidationError(
        "task_id",
        `this item is already on open task ${elsewhere.task_id} ("${elsewhere.title}"); update that task, or attach the item as evidence`,
      );
    }
    const { reopened } = await applyToTask(c, ctx, input, task, f, primary, others, runId, false);
    const outcome: Outcome = reopened ? "reopened" : "updated";
    await recordOutcome(c, ctx, runId, primary, outcome, task.id);
    return { task_id: task.id, outcome, status: reopened ? "open" : task.status };
  }

  const p = primary!;
  const finish = async (outcome: Outcome, taskId: string, extra: Partial<UpsertResult> = {}): Promise<UpsertResult> => {
    await recordOutcome(c, ctx, runId, p, outcome, taskId);
    const status = (await c.query<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id = $1", [taskId])).rows[0]!.status;
    return { task_id: taskId, outcome, status, ...extra };
  };
  const convertInto = async (taskId: string, outcome: "converted" | "updated", viaConversion: boolean, extra: Partial<UpsertResult> = {}) => {
    const task = (await loadTask(c, ctx.userId, taskId))!;
    const { reopened } = await applyToTask(c, ctx, input, task, f, p, others, runId, viaConversion);
    return finish(reopened ? "reopened" : outcome, taskId, outcome === "converted" ? { converted: true, matched_title: task.title, ...extra } : extra);
  };

  // Step 1: this exact item is already stored on a task, in any role and any status. Matching evidence and
  // resolution rows too means an item absorbed as context (or onto a done task) is never re-created on a re-read.
  const exact = (
    await c.query<{ row_id: string; task_id: string; via_conversion: boolean; status: TaskStatus }>(
      `SELECT ts.id AS row_id, ts.task_id, ts.via_conversion, t.status
       FROM task_sources ts JOIN tasks t ON t.id = ts.task_id
       WHERE t.user_id = $1 AND ts.source = $2 AND ts.item_key = $3
       ORDER BY (t.status = 'done'), (ts.role IN ('origin','update')) DESC, t.last_activity_at DESC`,
      [ctx.userId, p.source, p.item_key],
    )
  ).rows;
  if (exact.length) {
    const converted = input.separate_task ? exact.find((r) => r.via_conversion) : undefined;
    if (converted) {
      // The item reached that task only through a conversion: move it onto its own task (even if that task is done).
      await c.query("DELETE FROM task_sources WHERE id = $1", [converted.row_id]);
      await event(c, converted.task_id, "moved_out");
      const { taskId, linked } = await createTask(c, ctx, input, f, p, others, runId, [converted.task_id]);
      return finish("moved", taskId, { linked_to: linked });
    }
    const open = exact.find((r) => r.status !== "done");
    if (open) return convertInto(open.task_id, "updated", false);
    // Already on a done task: nothing changes, and a done task never reopens from a re-read.
    return finish("skipped-done", exact[0]!.task_id, { skipped: true });
  }

  // Drift rule: a known item with a new ask_index, read in a later run than the one that first saw it.
  const known = (
    await c.query<{ task_id: string; ask_index: number | null; status: TaskStatus; title: string }>(
      `SELECT ts.task_id, ts.ask_index, t.status, t.title
       FROM task_sources ts JOIN tasks t ON t.id = ts.task_id
       WHERE t.user_id = $1 AND ts.source = $2 AND ts.external_id = $3 AND ts.role IN ('origin','update')
       ORDER BY t.last_activity_at DESC, t.updated_at DESC, ts.ask_index DESC NULLS LAST`,
      [ctx.userId, p.source, p.external_id],
    )
  ).rows;
  if (known.length && !input.separate_task) {
    const first = (
      await c.query<{ run_id: string | null; run_status: string | null; created_at: Date }>(
        `SELECT o.run_id, r.status AS run_status, o.created_at
         FROM ingest_outcomes o LEFT JOIN ingest_runs r ON r.id = o.run_id
         WHERE o.user_id = $1 AND o.source = $2 AND o.external_id = $3 ORDER BY o.id LIMIT 1`,
        [ctx.userId, p.source, p.external_id],
      )
    ).rows[0];
    // New sibling asks are allowed while the item is still being read for the first time: in the same run, after a
    // first run that never finished cleanly (its asks may be incomplete), or in a burst of writes made without a run.
    const sameRun =
      !!first &&
      ((!!runId && first.run_id === runId) ||
        (first.run_id !== null && first.run_status !== "ok") ||
        (!runId && first.run_id === null && ctx.now.getTime() - first.created_at.getTime() < NO_RUN_BURST_MS));
    if (!sameRun) {
      const existing_asks = known.map((k) => ({ ask_index: k.ask_index, task_id: k.task_id, title: k.title, status: k.status }));
      const open = known.find((k) => k.status !== "done");
      if (!open) {
        await attachAsEvidence(c, known[0]!.task_id, [{ ...p, role: "evidence" }], runId);
        return finish("skipped-done", known[0]!.task_id, { skipped: true, existing_asks });
      }
      return convertInto(open.task_id, "converted", true, { existing_asks });
    }
  }

  // Step 2: thread-level match on open tasks (Calendar has none: each instance is its own item).
  const thread =
    p.source === "gcal"
      ? []
      : (
          await c.query<{ task_id: string; same_item: boolean }>(
            `SELECT t.id AS task_id, bool_or(ts.external_id = $4) AS same_item
             FROM task_sources ts JOIN tasks t ON t.id = ts.task_id
             WHERE t.user_id = $1 AND ts.source = $2 AND ts.thread_key = $3 AND ts.role IN ('origin','update') AND t.status <> 'done'
             GROUP BY t.id, t.last_activity_at, t.updated_at
             ORDER BY t.last_activity_at DESC, t.updated_at DESC`,
            [ctx.userId, p.source, p.thread_key, p.external_id],
          )
        ).rows;

  if (input.separate_task) {
    const related = [...new Set([...thread.map((m) => m.task_id), ...known.map((k) => k.task_id)])];
    const { taskId, linked } = await createTask(c, ctx, input, f, p, others, runId, related);
    return finish("created", taskId, { linked_to: linked });
  }
  if (thread.length) {
    const siblings = thread.filter((m) => m.same_item).map((m) => m.task_id);
    if (siblings.length) {
      const { taskId, linked } = await createTask(c, ctx, input, f, p, others, runId, siblings);
      return finish("created", taskId, { linked_to: linked });
    }
    return convertInto(thread[0]!.task_id, "converted", true);
  }

  const { taskId, linked } = await createTask(c, ctx, input, f, p, others, runId, []);
  return finish("created", taskId, linked.length ? { linked_to: linked } : {});
}
