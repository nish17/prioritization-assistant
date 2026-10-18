import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const KEYS = ["MCP_SECRET", "AUTH_MODE", "BACKFILL_DAYS", "SLICE_DAYS", "PORT", "POC_USER_EMAIL"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const set = (env: Record<string, string | undefined>) => {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
};
const GOOD = "ab".repeat(32);

describe("loadConfig", () => {
  it("applies defaults with a valid secret", () => {
    set({ MCP_SECRET: GOOD, POC_USER_EMAIL: "Jeevan@Example.com" });
    expect(loadConfig()).toMatchObject({ authMode: "path", backfillDays: 30, sliceDays: 7, port: 3000, pocUserEmail: "jeevan@example.com" });
  });

  it.each([
    ["a short secret", { MCP_SECRET: "abc123" }, /MCP_SECRET/],
    ["a non-hex secret", { MCP_SECRET: "z".repeat(64) }, /MCP_SECRET/],
    ["an unknown auth mode", { MCP_SECRET: GOOD, AUTH_MODE: "oauth" }, /AUTH_MODE/],
    ["slices longer than the backfill", { MCP_SECRET: GOOD, BACKFILL_DAYS: "2", SLICE_DAYS: "7" }, /SLICE_DAYS/],
    ["a non-integer slice", { MCP_SECRET: GOOD, SLICE_DAYS: "1.5" }, /SLICE_DAYS/],
  ])("refuses to start with %s, without echoing the secret", (_label, env, message) => {
    set(env as Record<string, string>);
    let thrown: Error | undefined;
    try {
      loadConfig();
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).toMatch(message);
    if ((env as Record<string, string>).MCP_SECRET) expect(thrown!.message).not.toContain((env as Record<string, string>).MCP_SECRET);
  });
});
