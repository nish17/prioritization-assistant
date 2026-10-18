import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type express from "express";

export interface Running {
  base: string;
  close(): Promise<void>;
}

export async function listen(app: express.Express): Promise<Running> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

export const initializeBody = (id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
});

/** Calls a JSON-RPC method on a stateless MCP endpoint and returns the parsed JSON body. */
export async function rpc(url: string, method: string, params: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
