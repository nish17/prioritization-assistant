import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { settingsShape } from "../../domain/settings.js";
import type { Store } from "../../domain/store.js";
import { ok, READ_ONLY, run, WRITE } from "../result.js";

export function registerSettingsTools(server: McpServer, store: () => Store): void {
  server.registerTool(
    "get_settings",
    {
      title: "Get settings",
      description: "Returns the saved key people (name, relationship, tier, emails, Slack handles and IDs, aliases), the items named as open during setup, and the time zone.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => run("get_settings", async () => ok(await store().getSettings())),
  );

  server.registerTool(
    "update_settings",
    {
      title: "Update settings",
      description:
        "Replaces the whole settings document: key people and the items named as open during setup. " +
        "Each person's relationship (client, co-founder, prospect, team, investor, other) sets their tier unless a tier is given. " +
        "A requester matching exactly one saved person by email, Slack ID, Slack handle or alias gets that person's tier and relationship label.",
      inputSchema: settingsShape,
      annotations: WRITE,
    },
    (input) => run("update_settings", async () => ok(await store().updateSettings(input))),
  );
}
