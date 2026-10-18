import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = "skill/daily-prioritizer";
const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
const field = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(front)?.[1]?.trim() ?? "";

describe("skill package", () => {
  it("has a valid name matching its folder and a description under 1,024 characters", () => {
    expect(field("name")).toBe("daily-prioritizer");
    expect(field("name")).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(field("description").length).toBeGreaterThan(50);
    expect(field("description").length).toBeLessThanOrEqual(1024);
  });

  it("keeps angle brackets out of the frontmatter, which claude.ai rejects as XML tags", () => {
    expect(front).not.toMatch(/[<>]/);
  });

  it("references only files that exist, and every reference file is referenced", () => {
    const refs = [...skill.matchAll(/`(references\/[a-z-]+\.md)`/g)].map((m) => m[1]!);
    for (const r of refs) expect(existsSync(join(dir, r)), r).toBe(true);
    for (const f of readdirSync(join(dir, "references"))) expect(refs).toContain(`references/${f}`);
  });

  it("names only tools the server exposes", () => {
    const tools = ["get_sync_state", "start_run", "finish_run", "reset_backfill", "find_related", "upsert_task", "list_tasks", "get_task", "update_status", "get_settings", "update_settings"];
    const all = [skill, ...readdirSync(join(dir, "references")).map((f) => readFileSync(join(dir, "references", f), "utf8"))].join("\n");
    const mentioned = new Set([...all.matchAll(/`([a-z]+_[a-z_]+)\(?/g)].map((m) => m[1]!).filter((n) => /^(get|start|finish|reset|find|upsert|list|update|set|override)_/.test(n)));
    for (const name of mentioned) expect(tools, name).toContain(name);
  });

  it("keeps the board's Act template as a trigger", () => {
    expect(field("description")).toContain("Draft a reply for task");
  });
});
