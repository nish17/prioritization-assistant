import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppDeps } from "../bootstrap.js";
import { registerBoard } from "./tools/board.js";

export function createMcpServer(deps: AppDeps): McpServer {
  const server = new McpServer({ name: "prioritizer", version: "0.1.0" });
  registerBoard(server, deps);
  return server;
}
