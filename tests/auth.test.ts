import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server.js";
import { createMcpServer } from "../src/mcp/createServer.js";
import type { AppDeps } from "../src/bootstrap.js";
import { initializeBody, listen, MCP_HEADERS, type Running } from "./helpers/http.js";

const SECRET = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
const OTHER = "b".repeat(64);
const deps = { close: async () => {} } as unknown as AppDeps;
const makeServer = () => createMcpServer(deps);

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

function expectBareNotFound(res: Response, body: string) {
  expect(res.status).toBe(404);
  expect(res.headers.get("www-authenticate")).toBeNull();
  expect(body).toBe("");
}

describe("path mode (default)", () => {
  let srv: Running;
  beforeAll(async () => {
    srv = await listen(createApp({ authMode: "path", secret: SECRET, makeServer }));
  });
  afterAll(() => srv.close());

  it("initializes on /mcp/<secret>", async () => {
    const res = await post(`${srv.base}/mcp/${SECRET}`, initializeBody());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.serverInfo.name).toBe("prioritizer");
  });

  it.each([
    ["wrong secret", `/mcp/${OTHER}`, {}],
    ["wrong length", `/mcp/abc`, {}],
    ["no secret", `/mcp`, {}],
    ["header-mode credential", `/mcp`, { "x-api-key": SECRET }],
    ["unknown route", `/.well-known/oauth-protected-resource`, {}],
  ])("returns a bare 404 for %s", async (_label, path, headers) => {
    const res = await post(`${srv.base}${path}`, initializeBody(), headers as Record<string, string>);
    expectBareNotFound(res, await res.text());
  });

  it("returns a bare 404 for a malformed percent-encoded path", async () => {
    const res = await post(`${srv.base}/mcp/%zz`, initializeBody());
    expectBareNotFound(res, await res.text());
  });

  it("returns 405 for GET and DELETE on the MCP route", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${srv.base}/mcp/${SECRET}`, { method });
      expect(res.status).toBe(405);
    }
  });

  it("returns 404 (not 405) for GET with a wrong secret", async () => {
    const res = await fetch(`${srv.base}/mcp/${OTHER}`);
    expectBareNotFound(res, await res.text());
  });

  it("answers notifications/initialized with 202 and an empty body", async () => {
    const res = await post(`${srv.base}/mcp/${SECRET}`, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("serves health without a secret, with no body", async () => {
    const res = await fetch(`${srv.base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("checks the secret before parsing the body", async () => {
    const res = await post(`${srv.base}/mcp/${OTHER}`, "{not json");
    expectBareNotFound(res, await res.text());
  });

  it("rejects bodies over 256 KB with a generic error", async () => {
    const big = JSON.stringify({ ...initializeBody(), pad: "x".repeat(300 * 1024) });
    const res = await post(`${srv.base}/mcp/${SECRET}`, big);
    expect(res.status).toBe(413);
    expect(await res.text()).not.toContain("x".repeat(100));
  });
});

describe("header mode", () => {
  let srv: Running;
  beforeAll(async () => {
    srv = await listen(createApp({ authMode: "header", secret: SECRET, makeServer }));
  });
  afterAll(() => srv.close());

  it("initializes with the correct x-api-key", async () => {
    const res = await post(`${srv.base}/mcp`, initializeBody(), { "x-api-key": SECRET });
    expect(res.status).toBe(200);
  });

  it.each([
    ["missing header", `/mcp`, {}],
    ["wrong header", `/mcp`, { "x-api-key": OTHER }],
    ["short header", `/mcp`, { "x-api-key": "abc" }],
    ["empty header", `/mcp`, { "x-api-key": "" }],
    ["path-mode credential", `/mcp/${SECRET}`, {}],
  ])("returns a bare 404 for %s", async (_label, path, headers) => {
    const res = await post(`${srv.base}${path}`, initializeBody(), headers as Record<string, string>);
    expectBareNotFound(res, await res.text());
  });
});

describe("secret hygiene", () => {
  const captured: string[] = [];
  afterEach(() => vi.restoreAllMocks());

  it("never writes the secret or the MCP path to logs or error responses", async () => {
    const capture = (...args: unknown[]) => void captured.push(args.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    const srv = await listen(createApp({ authMode: "path", secret: SECRET, makeServer }));
    try {
      const bodies: string[] = [];
      const url = `${srv.base}/mcp/${SECRET}`;
      for (const res of [
        await post(url, initializeBody()),
        await post(url, "{not json"),
        await post(url, JSON.stringify({ pad: "y".repeat(300 * 1024) })),
        await post(url, { jsonrpc: "2.0", id: 2, method: "no/such/method" }),
        await fetch(url),
      ]) {
        bodies.push(await res.text());
      }
      const all = [...captured, ...bodies].join("\n");
      expect(captured.length).toBeGreaterThan(0);
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain("/mcp/");
    } finally {
      await srv.close();
    }
  });
});
