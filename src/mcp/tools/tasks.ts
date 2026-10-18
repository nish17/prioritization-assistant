import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findRelatedShape, updateStatusShape, upsertTaskShape } from "../../domain/inputs.js";
import type { Store } from "../../domain/store.js";
import { ok, READ_ONLY, run, WRITE } from "../result.js";

export function registerTaskTools(server: McpServer, store: () => Store): void {
  server.registerTool(
    "find_related",
    {
      title: "Find related tasks",
      description:
        "Returns up to 5 stored tasks related to an incoming item, ranked by same thread, shared person (by email), then title similarity, " +
        "with match reasons and the 2 latest sources. Tasks closed more than 30 days ago are excluded. " +
        "For items already stored, also returns their existing ask_index numbering and task titles.",
      inputSchema: findRelatedShape,
      annotations: READ_ONLY,
    },
    (input) => run("find_related", async () => ok(await store().findRelated(input))),
  );

  server.registerTool(
    "upsert_task",
    {
      title: "Create or update task",
      description:
        "Creates a task, or updates one, from exactly one origin/update source item plus optional evidence. " +
        "The server checks the item against stored tasks: an item already stored updates its task (or is skipped if that task is done); " +
        "a later message in a thread that has an open task is merged into it (outcome converted, with the matched title); " +
        "a known item with a new ask_index in a later run is merged the same way. run_id is needed to create several tasks from one item. " +
        "separate_task creates a new task anyway. Returns the outcome, task_id, quadrant and the scoring rules that fired.",
      inputSchema: upsertTaskShape,
      annotations: WRITE,
    },
    (input) => run("upsert_task", async () => ok(await store().upsertTask(input))),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "Returns one task in full: signals, reasons, read-time quadrant and fired rules, status, all sources (excerpts and authors in fields marked untrusted), " +
        "entities, links, and the last 10 events.",
      inputSchema: { task_id: z.uuid() },
      annotations: READ_ONLY,
    },
    ({ task_id }) => run("get_task", async () => ok(await store().getTask(task_id))),
  );

  server.registerTool(
    "update_status",
    {
      title: "Update task status",
      description:
        "Sets a task's status: open, done, snoozed (needs snooze_until), waiting_on_others or delegated. " +
        "Waiting and delegated tasks get a follow-up date (the due date, or 3 business days) after which they return to the board.",
      inputSchema: updateStatusShape,
      annotations: { ...WRITE, idempotentHint: true },
    },
    (input) => run("update_status", async () => ok(await store().updateStatus(input))),
  );
}
