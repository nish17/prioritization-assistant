import { DEFAULT_SCORING, type RequesterTier, type ScoringConfig } from "./scoringConfig.js";

export const QUADRANTS = ["do", "schedule", "delegate", "defer"] as const;
export type Quadrant = (typeof QUADRANTS)[number];

export const TASK_KINDS = ["ask", "commitment", "decision", "risk", "follow_up", "prep"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = ["open", "snoozed", "delegated", "waiting_on_others", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type EffectiveStatus = TaskStatus | "expired";

export type DueConfidence = "explicit" | "inferred" | "none";

/** Stored signals and workflow fields. Scores are never stored; they are computed here on every read. */
export interface ScoringInput {
  kind: TaskKind;
  /** For a prep task, the meeting start. */
  due_at: Date | null;
  due_confidence: DueConfidence | null;
  waiting_on_user: boolean;
  ask_received_at: Date | null;
  requester_tier: RequesterTier | null;
  risk_flags: readonly string[];
  urgency_language: boolean;
  delegable: boolean;
  suggested_delegate: string | null;
  claude_importance: number | null;
  quadrant_override: Quadrant | null;
  status: TaskStatus;
  snooze_until: Date | null;
  follow_up_at: Date | null;
  last_activity_at: Date;
}

export interface FiredRule {
  axis: "urgency" | "importance";
  code: string;
  label: string;
  points: number;
}

export interface ScoreResult {
  urgency: number;
  importance: number;
  urgent: boolean;
  important: boolean;
  computed_quadrant: Quadrant;
  quadrant: Quadrant;
  overridden: boolean;
  effective_status: EffectiveStatus;
  overdue: boolean;
  could_delegate: boolean;
  rules_fired: FiredRule[];
  rules_version: string;
}

const H = 3_600_000;

export function scoreTask(t: ScoringInput, now: Date, cfg: ScoringConfig = DEFAULT_SCORING): ScoreResult {
  const fired: FiredRule[] = [];
  const add = (axis: FiredRule["axis"], code: string, label: string, points: number) => {
    if (points > 0) fired.push({ axis, code, label, points });
  };
  const u = cfg.urgency;
  const nowMs = now.getTime();
  let overdue = false;

  if (t.kind === "prep") {
    // The meeting start is when the prep is needed, not a deadline, so the due-date rules don't apply.
    if (t.due_at && t.due_at.getTime() >= nowMs && t.due_at.getTime() - nowMs <= 24 * H) {
      add("urgency", "prep_24h", "Prep for a meeting in the next 24 hours", u.prepWithin24h);
    }
  } else if (t.due_at) {
    const hoursLeft = (t.due_at.getTime() - nowMs) / H;
    const inferred = t.due_confidence !== "explicit";
    const penalty = inferred ? u.inferredPenalty : 0;
    const suffix = inferred ? ` (inferred, -${u.inferredPenalty})` : "";
    if (hoursLeft < 0) {
      overdue = true;
      add("urgency", "overdue", `Overdue${suffix}`, Math.max(0, u.overdue - penalty));
    } else if (hoursLeft <= 48) {
      add("urgency", "due_48h", `Due within 48 hours${suffix}`, Math.max(0, u.within48h - penalty));
    } else if (hoursLeft <= 7 * 24) {
      add("urgency", "due_7d", `Due within 7 days${suffix}`, Math.max(0, u.within7d - penalty));
    }
  }

  if (t.waiting_on_user) {
    const ageHours = t.ask_received_at ? (nowMs - t.ask_received_at.getTime()) / H : 0;
    if (ageHours > u.waitingOldAfterHours) add("urgency", "waiting_old", "Waiting on you for more than 2 days", u.waitingOld);
    else add("urgency", "waiting", "Waiting on you", u.waitingNew);
  }
  if (t.urgency_language) add("urgency", "urgency_language", "Urgent language", u.urgencyLanguage);

  const imp = cfg.importance;
  if (t.requester_tier) add("importance", `tier_${t.requester_tier}`, `Requester: ${t.requester_tier}`, imp.tiers[t.requester_tier] ?? 0);
  for (const group of imp.flagGroups) {
    if (group.flags.some((f) => t.risk_flags.includes(f))) add("importance", `flag_${group.flags.join("_")}`, group.label, group.points);
  }
  if (t.claude_importance !== null && Number.isFinite(t.claude_importance)) {
    const ci = Math.min(imp.claudeMax, Math.max(0, Math.round(t.claude_importance)));
    add("importance", "claude_importance", "Strategic weight (Claude's judgment)", ci);
  }

  const sum = (axis: FiredRule["axis"]) => fired.filter((r) => r.axis === axis).reduce((n, r) => n + r.points, 0);
  const urgency = sum("urgency");
  const importance = sum("importance");
  const urgent = urgency >= cfg.thresholds.urgent;
  const important = importance >= cfg.thresholds.important;
  const computed: Quadrant = urgent ? (important ? "do" : "delegate") : important ? "schedule" : "defer";
  const quadrant = t.quadrant_override ?? computed;

  return {
    urgency,
    importance,
    urgent,
    important,
    computed_quadrant: computed,
    quadrant,
    overridden: t.quadrant_override !== null,
    effective_status: effectiveStatus(t, nowMs),
    overdue,
    could_delegate: quadrant === "do" && t.delegable && !!t.suggested_delegate,
    rules_fired: fired,
    rules_version: cfg.rules_version,
  };
}

function effectiveStatus(t: ScoringInput, nowMs: number): EffectiveStatus {
  if (t.status === "done") return "done";
  if (t.kind === "prep" && t.due_at && t.due_at.getTime() < nowMs) return "expired";
  if (t.status === "snoozed") return t.snooze_until && t.snooze_until.getTime() <= nowMs ? "open" : "snoozed";
  if (t.status === "waiting_on_others" || t.status === "delegated") {
    return t.follow_up_at && t.follow_up_at.getTime() <= nowMs ? "open" : t.status;
  }
  return "open";
}

type Orderable = Pick<ScoringInput, "due_at" | "last_activity_at">;

/** Design 9.6: overdue first, then due date ascending, then importance descending, then latest activity. */
export function compareTasks(a: Orderable, sa: ScoreResult, b: Orderable, sb: ScoreResult): number {
  if (sa.overdue !== sb.overdue) return sa.overdue ? -1 : 1;
  const da = a.due_at?.getTime() ?? Infinity;
  const db = b.due_at?.getTime() ?? Infinity;
  if (da !== db) return da < db ? -1 : 1;
  if (sa.importance !== sb.importance) return sb.importance - sa.importance;
  return b.last_activity_at.getTime() - a.last_activity_at.getTime();
}
