import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../../domain/store.js";
import { RUN_MODES, runCountsSchema, SOURCES } from "../../domain/inputs.js";
import { DESTRUCTIVE, ok, READ_ONLY, run, WRITE } from "../result.js";

export function registerRunTools(server: McpServer, store: () => Store): void {
  server.registerTool(
    "get_sync_state",
    {
      title: "Get sync state",
      description:
        "Returns per-source ingestion progress (backfill slices done and estimated, next backfill window, last successful run, stale flag) " +
        "and the thread keys of up to 50 open Gmail and Slack tasks each.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => run("get_sync_state", async () => ok(await store().getSyncState())),
  );

  server.registerTool(
    "start_run",
    {
      title: "Start ingestion run",
      description:
        "Opens an ingestion run for one source and returns its run_id, the time window the server assigned (window_from, window_to), " +
        "whether it is the last backfill slice, and query fragments for that window. Backfill runs step back from the newest week; " +
        "refresh runs start one hour before the last successful run. Calendar always covers now to 7 days ahead. " +
        "Returns status backfill_incomplete for a refresh of a source whose backfill is not finished.",
      inputSchema: {
        mode: z.enum(RUN_MODES),
        source: z.enum(SOURCES),
      },
      annotations: WRITE,
    },
    ({ mode, source }) => run("start_run", async () => ok(await store().startRun(mode, source))),
  );

  server.registerTool(
    "finish_run",
    {
      title: "Finish ingestion run",
      description:
        "Closes a run. On ok, the source's window advances (a backfill slice is counted, or the refresh cursor moves to the window end). " +
        "A capped run (more items than the per-slice cap) is not counted: the next run covers it in half-size slices. " +
        "On partial or failed, nothing advances and the error is recorded.",
      inputSchema: {
        run_id: z.uuid(),
        status: z.enum(["ok", "partial", "failed"]),
        counts: runCountsSchema,
        error: z.string().max(1000).optional(),
      },
      annotations: WRITE,
    },
    ({ run_id, status, counts, error }) => run("finish_run", async () => ok(await store().finishRun(run_id, status, counts, error))),
  );

  server.registerTool(
    "reset_backfill",
    {
      title: "Reset backfill",
      description:
        "Puts a source back to its first backfill slice. With delete_tasks, also deletes the source pointers written by that source's backfill runs " +
        "and any task left with no origin or update source. Tasks that gained a pointer from another source keep it.",
      inputSchema: {
        source: z.enum(SOURCES),
        delete_tasks: z.boolean(),
      },
      annotations: DESTRUCTIVE,
    },
    ({ source, delete_tasks }) => run("reset_backfill", async () => ok(await store().resetBackfill(source, delete_tasks))),
  );
}
