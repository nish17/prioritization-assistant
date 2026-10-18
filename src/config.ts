export type AuthMode = "path" | "header";

export interface Config {
  port: number;
  authMode: AuthMode;
  secret: string;
  databaseUrl: string | undefined;
  pocUserEmail: string;
  pocUserName: string;
  timezone: string;
  backfillDays: number;
  sliceDays: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(): Config {
  const authMode = (process.env.AUTH_MODE ?? "path") as AuthMode;
  if (authMode !== "path" && authMode !== "header") throw new Error("AUTH_MODE must be path or header");
  const secret = process.env.MCP_SECRET ?? "";
  // 32 random bytes, hex-encoded. Refuse to start with anything weaker.
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error("MCP_SECRET must be 64 hex characters (npm run secret)");
  const sliceDays = intEnv("SLICE_DAYS", 7);
  const backfillDays = intEnv("BACKFILL_DAYS", 30);
  if (sliceDays > backfillDays) throw new Error("SLICE_DAYS must not exceed BACKFILL_DAYS");
  return {
    port: intEnv("PORT", 3000),
    authMode,
    secret,
    databaseUrl: process.env.DATABASE_URL || undefined,
    pocUserEmail: (process.env.POC_USER_EMAIL ?? "user@example.com").toLowerCase(),
    pocUserName: process.env.POC_USER_NAME ?? "POC user",
    timezone: process.env.USER_TIMEZONE ?? "Asia/Kolkata",
    backfillDays,
    sliceDays,
  };
}
