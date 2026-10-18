import type { ScoringInput, TaskKind, TaskStatus, Quadrant, DueConfidence } from "./scoring.js";
import type { RequesterTier } from "./scoringConfig.js";

export interface TaskRow {
  id: string;
  title: string;
  summary: string | null;
  kind: TaskKind;
  workstream: string | null;
  due_at: Date | null;
  due_confidence: DueConfidence;
  waiting_on_user: boolean;
  ask_received_at: Date | null;
  requester_tier: RequesterTier | null;
  requester_name: string | null;
  requester_label: string | null;
  risk_flags: string[];
  urgency_language: boolean;
  delegable: boolean;
  suggested_delegate: string | null;
  claude_importance: number | null;
  urgency_reason: string | null;
  importance_reason: string | null;
  quadrant_override: Quadrant | null;
  override_reason: string | null;
  rules_version: string;
  status: TaskStatus;
  status_note: string | null;
  snooze_until: Date | null;
  delegated_to: string | null;
  follow_up_at: Date | null;
  status_changed_at: Date;
  first_seen_at: Date;
  last_activity_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

export const TASK_COLUMNS = `t.id, t.title, t.summary, t.kind, t.workstream, t.due_at, t.due_confidence, t.waiting_on_user,
  t.ask_received_at, t.requester_tier, t.requester_name, t.requester_label, t.risk_flags, t.urgency_language, t.delegable,
  t.suggested_delegate, t.claude_importance, t.urgency_reason, t.importance_reason, t.quadrant_override, t.override_reason,
  t.rules_version, t.status, t.status_note, t.snooze_until, t.delegated_to, t.follow_up_at, t.status_changed_at,
  t.first_seen_at, t.last_activity_at, t.updated_at, t.closed_at`;

export function toScoringInput(t: TaskRow): ScoringInput {
  return {
    kind: t.kind,
    due_at: t.due_at,
    due_confidence: t.due_confidence,
    waiting_on_user: t.waiting_on_user,
    ask_received_at: t.ask_received_at,
    requester_tier: t.requester_tier,
    risk_flags: t.risk_flags,
    urgency_language: t.urgency_language,
    delegable: t.delegable,
    suggested_delegate: t.suggested_delegate,
    claude_importance: t.claude_importance,
    quadrant_override: t.quadrant_override,
    status: t.status,
    snooze_until: t.snooze_until,
    follow_up_at: t.follow_up_at,
    last_activity_at: t.last_activity_at,
  };
}
