// Mirrors the list_tasks / get_task payloads (src/domain/store.ts). Kept separate so the board bundle has no server code.
export type Quadrant = "do" | "schedule" | "delegate" | "defer";
export type Source = "gmail" | "slack" | "gcal" | "granola";
export const QUADRANTS: Quadrant[] = ["do", "schedule", "delegate", "defer"];

export interface Chip {
  source: Source;
  title: string | null;
  occurred_at: string;
  url: string | null;
}

export interface Card {
  id: string;
  title: string;
  kind: string;
  quadrant: Quadrant;
  overridden: boolean;
  urgency: number;
  importance: number;
  overdue: boolean;
  due_at: string | null;
  follow_up_due: boolean;
  could_delegate: boolean;
  suggested_delegate: string | null;
  requester: { name: string | null; label: string | null } | null;
  reasons: { urgency: string | null; importance: string | null };
  sources: Chip[];
  source_count: number;
}

export interface Board {
  election: { createdAt: number; seq: number };
  generated_at: string;
  rules_version: string;
  timezone: string;
  header: {
    sources: { source: Source; backfill_complete: boolean; last_success_at: string | null; stale: boolean }[];
    counts: Record<"open" | "snoozed" | "waiting_on_others" | "delegated" | "done" | "expired", number>;
  };
  quadrants: Record<Quadrant, { total: number; cards: Card[] }>;
}

export interface TaskDetails {
  task: {
    id: string;
    summary: string | null;
    status_note: string | null;
    rules_fired: { axis: "urgency" | "importance"; label: string; points: number }[];
  };
  sources: {
    source: Source;
    role: string;
    title: string | null;
    url: string | null;
    occurred_at: string | null;
    untrusted_author: string | null;
    untrusted_excerpt: string | null;
  }[];
}

export function isBoard(x: unknown): x is Board {
  const b = x as Board | null;
  return !!b && typeof b === "object" && !!b.quadrants && QUADRANTS.every((q) => Array.isArray(b.quadrants[q]?.cards)) && !!b.header;
}
