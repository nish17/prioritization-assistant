// Logs carry only request IDs, tool names, status codes, counts and error codes.
// Never pass request bodies, URLs, excerpts or Postgres error details here.
type Field = string | number | boolean | null | undefined;

export function log(event: string, fields: Record<string, Field> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

export function logError(event: string, err: unknown, fields: Record<string, Field> = {}): void {
  const e = err as { code?: unknown; name?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : typeof e?.name === "string" ? e.name : "unknown";
  console.error(JSON.stringify({ t: new Date().toISOString(), event, code, ...fields }));
}
