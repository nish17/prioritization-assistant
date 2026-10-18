// Every stored string passes through here. Source content is untrusted: strip markup and
// invisible characters (zero-width, bidi overrides, other Unicode format/control characters),
// collapse whitespace, and cap by code point.

export const LIMITS = {
  title: 120,
  summary: 500,
  reason: 300,
  excerpt: 280,
  author: 120,
  sourceTitle: 120,
  name: 120,
  label: 60,
  note: 300,
  workstream: 40,
  urlText: 300,
  keyword: 200,
} as const;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const TAGS = /<\/?[a-zA-Z!][^<>]*>/g;
// Cc control, Cf format (zero-width, bidi overrides and isolates, BOM, soft hyphen), Co private use, Cs lone surrogates.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu;

export function cleanText(input: string | null | undefined, max: number): string | null {
  if (input === null || input === undefined) return null;
  let s = input.normalize("NFC").replace(/[\r\n\t\f\v]+/g, " ");
  s = s.replace(TAGS, " ");
  s = s.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? "");
  s = s.replace(TAGS, " ");
  s = s.replace(INVISIBLE, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  const points = Array.from(s);
  if (points.length <= max) return s;
  return points.slice(0, max - 1).join("").trimEnd() + "…";
}

/** Lowercased, punctuation-free form used for trigram similarity. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function allowedHost(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  if (h === "mail.google.com" || h === "calendar.google.com") return true;
  if (h === "www.google.com") return url.pathname.startsWith("/calendar/");
  if (h === "slack.com" || h.endsWith(".slack.com")) return true;
  // Granola: both the current and the earlier domain (check against tests/fixtures/connector-samples.json).
  for (const d of ["granola.ai", "granola.so"]) if (h === d || h.endsWith(`.${d}`)) return true;
  return false;
}

/** A link is stored only for https on an allowed host; anything else is kept as plain text. */
export function cleanUrl(input: string | null | undefined): { url: string | null; url_text: string | null } {
  if (!input) return { url: null, url_text: null };
  const trimmed = input.trim();
  try {
    const u = new URL(trimmed);
    if (u.protocol === "https:" && !u.username && !u.password && !u.port && allowedHost(u) && trimmed.length <= 2000) {
      return { url: u.toString(), url_text: null };
    }
  } catch {
    // not a URL
  }
  return { url: null, url_text: cleanText(trimmed, LIMITS.urlText) };
}
