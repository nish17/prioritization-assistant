import { z } from "zod";
import type { Client, Pool } from "../db/pool.js";
import { cleanText, LIMITS } from "./sanitize.js";
import { REQUESTER_TIERS, type RequesterTier } from "./scoringConfig.js";

// R11: the user's own relationship terms map onto the internal tiers. Tier names never reach card text.
export const RELATIONSHIP_TIERS: Record<string, RequesterTier> = {
  client: "portfolio_ceo",
  "co-founder": "principal",
  cofounder: "principal",
  partner: "principal",
  prospect: "principal",
  investor: "lp",
  team: "internal_team",
  advisor: "external_counterparty",
  vendor: "vendor",
  other: "external_counterparty",
};

export const personSchema = z.object({
  name: z.string().min(1).max(200),
  relationship: z.string().min(1).max(60).describe("The user's own term: client, co-founder, prospect, team, investor, other"),
  tier: z.enum(REQUESTER_TIERS).optional().describe("Optional; derived from relationship when omitted"),
  emails: z.array(z.string().max(320)).max(10).optional(),
  slack_handles: z.array(z.string().max(128)).max(5).optional(),
  slack_ids: z.array(z.string().max(64)).max(5).optional(),
  aliases: z.array(z.string().max(200)).max(10).optional(),
  organization: z.string().max(200).optional(),
});

export const settingsShape = {
  people: z.array(personSchema).max(50),
  known_open_items: z.array(z.string().max(500)).max(20).optional().describe("Items the user named as open during setup, for the coverage check"),
};
export const settingsSchema = z.object(settingsShape);
export type SettingsInput = z.infer<typeof settingsSchema>;

export interface Person {
  name: string;
  relationship: string;
  tier: RequesterTier;
  emails: string[];
  slack_handles: string[];
  slack_ids: string[];
  aliases: string[];
  organization: string | null;
}

export interface Settings {
  people: Person[];
  known_open_items: string[];
}

const lowerList = (xs: string[] | undefined, max: number) =>
  [...new Set((xs ?? []).map((x) => cleanText(x, max)?.toLowerCase()).filter((x): x is string => !!x))];

export function normalizeSettings(input: SettingsInput): Settings {
  return {
    people: input.people.map((p) => {
      const relationship = cleanText(p.relationship, LIMITS.label)?.toLowerCase() ?? "other";
      return {
        name: cleanText(p.name, LIMITS.name) ?? "Unknown",
        relationship,
        tier: p.tier ?? RELATIONSHIP_TIERS[relationship] ?? "external_counterparty",
        emails: lowerList(p.emails, 320),
        slack_handles: lowerList(p.slack_handles, 128).map((h) => h.replace(/^@/, "")),
        slack_ids: lowerList(p.slack_ids, 64),
        aliases: lowerList(p.aliases, LIMITS.name),
        organization: cleanText(p.organization, LIMITS.name),
      };
    }),
    known_open_items: (input.known_open_items ?? []).map((s) => cleanText(s, 500)).filter((s): s is string => !!s),
  };
}

/** People whose relationship isn't one of the known terms and who have no explicit tier: they fall to "other". */
export function unmappedRelationships(input: SettingsInput): string[] {
  return input.people
    .filter((p) => !p.tier && !RELATIONSHIP_TIERS[p.relationship.trim().toLowerCase()])
    .map((p) => `${p.name}: relationship "${p.relationship}" is not a known term, so they are weighed as "other" (use client, co-founder, prospect, team, investor or other, or give a tier)`);
}

export async function getSettings(db: Pool | Client, userId: string): Promise<Settings> {
  const { rows } = await db.query("SELECT people, known_open_items FROM user_settings WHERE user_id = $1", [userId]);
  return { people: rows[0]?.people ?? [], known_open_items: rows[0]?.known_open_items ?? [] };
}

export async function saveSettings(db: Pool | Client, userId: string, settings: Settings): Promise<void> {
  await db.query(
    `INSERT INTO user_settings (user_id, people, known_open_items, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET people = EXCLUDED.people, known_open_items = EXCLUDED.known_open_items, updated_at = now()`,
    [userId, JSON.stringify(settings.people), JSON.stringify(settings.known_open_items)],
  );
}

export interface RequesterRef {
  name?: string | null;
  email?: string | null;
  slack_id?: string | null;
  slack_handle?: string | null;
}

/**
 * Finds the saved person behind a requester: email first, then Slack ID, then Slack handle, then name or alias.
 * The first step with any match decides, and only a unique match counts, so a shared alias forces nothing.
 */
export function matchPerson(people: Person[], r: RequesterRef | undefined): Person | null {
  if (!r) return null;
  const email = r.email?.trim().toLowerCase();
  const slackId = r.slack_id?.trim().toLowerCase();
  const handle = r.slack_handle?.trim().toLowerCase().replace(/^@/, "");
  const name = r.name ? cleanText(r.name, LIMITS.name)?.toLowerCase() : undefined;
  const steps: ((p: Person) => boolean)[] = [];
  if (email) steps.push((p) => p.emails.includes(email));
  if (slackId) steps.push((p) => p.slack_ids.includes(slackId));
  if (handle) steps.push((p) => p.slack_handles.includes(handle));
  if (name) steps.push((p) => p.name.toLowerCase() === name || p.aliases.includes(name));
  for (const step of steps) {
    const hits = people.filter(step);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) return null;
  }
  return null;
}
