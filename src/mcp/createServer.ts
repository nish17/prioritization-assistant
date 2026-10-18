import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppDeps } from "../bootstrap.js";
import { registerBoard } from "./tools/board.js";
import { registerRunTools } from "./tools/runs.js";
import { registerSettingsTools } from "./tools/settings.js";
import { registerTaskTools } from "./tools/tasks.js";

export function createMcpServer(deps: Pick<AppDeps, "store">): McpServer {
  const server = new McpServer({ name: "prioritizer", version: "0.1.0" });
  const store = () => deps.store;
  registerRunTools(server, store);
  registerTaskTools(server, store);
  registerBoard(server, store);
  registerSettingsTools(server, store);
  return server;
}
