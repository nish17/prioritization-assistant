import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { listTasksShape } from "../../domain/inputs.js";
import type { Store } from "../../domain/store.js";
import { ok, READ_ONLY, run } from "../result.js";

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

export function registerBoard(server: McpServer, store: () => Store): void {
  const { html, uri } = boardResource();

  registerAppTool(
    server,
    "list_tasks",
    {
      title: "Show task board",
      description:
        "Returns the prioritized board: open tasks in the four Eisenhower quadrants (do, schedule, delegate, defer), ordered within each, " +
        "with reasons, requester, up to 3 source chips, per-source freshness, and counts of waiting, delegated and snoozed tasks. " +
        "Renders as an interactive board where supported; the text lists each quadrant's top items with task ids. " +
        "With quadrant set, only that quadrant's cards are returned (up to 50); the others carry totals only.",
      inputSchema: listTasksShape,
      annotations: READ_ONLY,
      _meta: { ui: { resourceUri: uri } },
    },
    (input) =>
      run("list_tasks", async () => {
        const { board, text } = await store().listTasks(input);
        return ok(board, text);
      }),
  );

  registerAppResource(server, "Task board", uri, { description: "Interactive Eisenhower board" }, async () => ({
    contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }],
  }));
}
