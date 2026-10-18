import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { AppDeps } from "../../bootstrap.js";

let cached: { html: string; uri: string } | undefined;

/** The single-file board built by Vite. The URI carries a content hash so Claude never shows a stale build. */
export function boardResource(): { html: string; uri: string } {
  if (cached) return cached;
  const path = process.env.BOARD_HTML_PATH ?? resolve(process.cwd(), "dist/board/index.html");
  let html: string;
  try {
    html = readFileSync(path, "utf8");
  } catch {
    html = "<!doctype html><meta charset=utf-8><p>Board not built. Run npm run build:board.</p>";
  }
  const hash = createHash("sha256").update(html).digest("hex").slice(0, 10);
  cached = { html, uri: `ui://prioritizer/board-${hash}` };
  return cached;
}

// Unit 0 stub: proves the app renders and round-trips. Replaced by the real list_tasks in Unit 4.
export function registerBoard(server: McpServer, _deps: AppDeps): void {
  const { html, uri } = boardResource();

  registerAppTool(
    server,
    "list_tasks",
    {
      title: "List tasks",
      description: "Returns the prioritized task board: open tasks grouped into the four Eisenhower quadrants, with per-source freshness.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: uri } },
    },
    async () => ({
      content: [{ type: "text", text: "Board stub: no tasks yet." }],
      structuredContent: { stub: true, generated_at: new Date().toISOString() },
    }),
  );

  server.registerTool(
    "update_status",
    {
      title: "Update task status",
      description: "Sets a task's status (open, done, snoozed, waiting_on_others, delegated).",
      inputSchema: {
        task_id: z.string().max(64),
        status: z.enum(["open", "done", "snoozed", "waiting_on_others", "delegated"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ task_id, status }) => ({
      content: [{ type: "text", text: `Stub: would set ${task_id} to ${status}.` }],
      structuredContent: { stub: true, task_id, status },
    }),
  );

  registerAppResource(server, "Task board", uri, { description: "Interactive Eisenhower board" }, async () => ({
    contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }],
  }));
}
