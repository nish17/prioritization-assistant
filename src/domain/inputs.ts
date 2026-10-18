import { z } from "zod";
import { QUADRANTS, TASK_KINDS, TASK_STATUSES } from "./scoring.js";
import { REQUESTER_TIERS, RISK_FLAGS } from "./scoringConfig.js";

// One source list shared by Zod and every CHECK constraint in 001_init.sql.
export const SOURCES = ["gmail", "slack", "gcal", "granola"] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_ROLES = ["origin", "update", "evidence", "resolution"] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

export const ENTITY_TYPES = ["person", "company", "deal", "portfolio_company"] as const;
export const LINK_TYPES = ["related", "follows_up", "blocks"] as const;

// Raw strings are capped here; sanitize.ts then trims each field to its stored length by code point.
const RAW = 4000;
const raw = () => z.string().max(RAW);
const id = () => z.string().min(1).max(256);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;
export const isoInstant = () =>
  z
    .string()
    .max(40)
    .refine((s) => ISO_DATETIME.test(s) && !Number.isNaN(Date.parse(s)), "must be ISO 8601 with a time zone, e.g. 2026-10-22T09:00:00Z");
/** A date-time with offset, or a bare date (read as 18:00 in the user's time zone). */
export const isoDue = () =>
  z
    .string()
    .max(40)
    .refine((s) => ISO_DATE.test(s) || (ISO_DATETIME.test(s) && !Number.isNaN(Date.parse(s))), "must be ISO 8601 with a time zone, or a date like 2026-10-22");

export const sourceRefSchema = z.object({
  source: z.enum(SOURCES),
  external_id: id().describe("Gmail message ID; Slack channel:ts; Calendar event-instance ID; Granola meeting ID"),
  ask_index: z.number().int().min(1).max(50).optional().describe("Set when one item holds several asks (1, 2, ...). Granola: position in the action-item list"),
  thread_key: id().optional().describe("Gmail thread ID or Slack channel:thread_ts (channel:ts for a top-level message). Required for gmail and slack"),
  role: z.enum(SOURCE_ROLES).describe("origin/update: the item that states or changes the ask. evidence: context. resolution: the user's reply that closed it"),
  occurred_at: isoInstant(),
  title: raw().optional().describe("Email subject, meeting title, or channel name"),
  url: z.string().max(2000).optional(),
  author: raw().optional(),
  excerpt: raw().optional().describe("The sentence that proves the ask (stored up to 280 characters)"),
});
export type SourceRefInput = z.infer<typeof sourceRefSchema>;

export const signalsSchema = z.object({
  due_at: isoDue().nullable().optional(),
  due_confidence: z.enum(["explicit", "inferred", "none"]).optional(),
  waiting_on_user: z.boolean().optional(),
  ask_received_at: isoInstant().nullable().optional(),
  requester_tier: z.enum(REQUESTER_TIERS).optional(),
  risk_flags: z.array(z.enum(RISK_FLAGS)).max(6).optional(),
  urgency_language: z.boolean().optional(),
  delegable: z.boolean().optional(),
  suggested_delegate: raw().nullable().optional(),
  claude_importance: z.number().min(-10).max(10).optional(),
});

export const requesterSchema = z.object({
  name: raw().optional(),
  email: z.string().max(320).optional(),
  slack_id: z.string().max(64).optional(),
  slack_handle: z.string().max(128).optional(),
});

export const taskFieldsSchema = z.object({
  title: raw().optional().describe("Imperative, under 90 characters. Required for decision=new"),
  summary: raw().optional(),
  kind: z.enum(TASK_KINDS).optional().describe("Required for decision=new. prep = prepare for a meeting (due_at = meeting start)"),
  workstream: z.string().max(80).optional(),
  signals: signalsSchema.optional(),
  urgency_reason: raw().optional(),
  importance_reason: raw().optional(),
  requester: requesterSchema.optional(),
});

export const entityInputSchema = z.object({
  type: z.enum(ENTITY_TYPES),
  name: z.string().min(1).max(300),
  email: z.string().max(320).optional(),
  role: z.enum(["requester", "subject", "attendee", "owner"]).optional(),
});

export const upsertTaskShape = {
  decision: z.enum(["new", "update"]),
  task_id: z.uuid().optional().describe("Required for decision=update"),
  run_id: z.uuid().optional(),
  separate_task: z.boolean().optional().describe("Create a separate task even though this thread already has one (a genuinely different ask in a later message)"),
  task: taskFieldsSchema,
  sources: z.array(sourceRefSchema).min(1).max(20).describe("Exactly one origin/update source for decision=new; at most one for update. Others are evidence or resolution"),
  entities: z.array(entityInputSchema).max(10).optional(),
  link_to: z
    .array(z.object({ task_id: z.uuid(), link_type: z.enum(LINK_TYPES) }))
    .max(5)
    .optional(),
};
export const upsertTaskSchema = z.object(upsertTaskShape);
export type UpsertTaskInput = z.infer<typeof upsertTaskSchema>;

export const findRelatedShape = {
  entities: z.array(entityInputSchema.pick({ type: true, name: true, email: true })).max(10).optional(),
  keywords: z.array(z.string().max(200)).max(10).optional(),
  thread_keys: z.array(z.object({ source: z.enum(SOURCES), thread_key: id() })).max(10).optional(),
  items: z
    .array(z.object({ source: z.enum(SOURCES), external_id: id() }))
    .max(10)
    .optional()
    .describe("Items being processed; for any already stored, returns the existing ask_index numbering"),
};
export const findRelatedSchema = z.object(findRelatedShape);
export type FindRelatedInput = z.infer<typeof findRelatedSchema>;

export const updateStatusShape = {
  task_id: z.uuid(),
  status: z.enum(TASK_STATUSES),
  snooze_until: isoInstant().optional().describe("Required for snoozed"),
  delegated_to: z.string().max(300).optional(),
  note: z.string().max(1000).optional(),
};
export const updateStatusSchema = z.object(updateStatusShape);
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;

export const listTasksShape = {
  quadrant: z.enum(QUADRANTS).optional().describe("Only this quadrant"),
  limit_per_quadrant: z.number().int().min(1).max(50).optional().describe("Default 12"),
};
export const listTasksSchema = z.object(listTasksShape);
export type ListTasksInput = z.infer<typeof listTasksSchema>;

export const RUN_MODES = ["backfill", "refresh"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const runCountsSchema = z.object({
  fetched: z.number().int().min(0).max(100000),
  evaluated: z.number().int().min(0).max(100000),
  not_a_task: z.number().int().min(0).max(100000),
  capped: z.boolean().optional().describe("More items matched than the per-slice cap"),
});
export type RunCounts = z.infer<typeof runCountsSchema>;
