import { pathToFileURL } from "node:url";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { secretMatcher } from "./auth/secret.js";
import { loadConfig, type AuthMode } from "./config.js";
import { log, logError } from "./log.js";

export interface AppOptions {
  authMode: AuthMode;
  secret: string;
  /** Builds a fresh MCP server per request (stateless transport). */
  makeServer: () => McpServer;
}

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

// Unknown routes and failed secret checks look identical: a bare 404 with no auth challenge,
// so Claude never starts OAuth discovery and the response reveals nothing.
const notFound: RequestHandler = (_req, res) => {
  res.status(404).end();
};

export function createApp(opts: AppOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  const matchesSecret = secretMatcher(opts.secret);
  let seq = 0;

  // Request log: method, route label, status, duration. Never the URL (path mode carries the secret).
  app.use((req, res, next) => {
    const id = (++seq).toString(36);
    const started = Date.now();
    res.on("finish", () => {
      log("http", { id, method: req.method, route: res.locals.route ?? "other", status: res.statusCode, ms: Date.now() - started });
    });
    next();
  });

  // The only route exempt from the secret: bare 200, no data.
  app.get("/healthz", (_req, res) => {
    res.locals.route = "health";
    res.status(200).end();
  });

  const mcpPath = opts.authMode === "path" ? "/mcp/:secret" : "/mcp";
  const requireSecret: RequestHandler = (req, res, next) => {
    const candidate = opts.authMode === "path" ? req.params.secret : req.get("x-api-key");
    if (!matchesSecret(candidate)) return notFound(req, res, next);
    res.locals.route = "mcp";
    next();
  };
  // Parse every POST body as JSON (capped), so the transport never reads an unbounded stream itself.
  const parseBody = express.json({ limit: "256kb", type: () => true });

  const handleMcp: RequestHandler = async (req, res, next) => {
    const server = opts.makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  };

  // Order: secret check → body parsing → MCP.
  app.post(mcpPath, requireSecret, parseBody, handleMcp);
  app.all(mcpPath, requireSecret, (_req, res) => {
    res.status(405).set("Allow", "POST").json(jsonRpcError(-32000, "Method not allowed."));
  });

  app.use(notFound);

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
    logError("http_error", err, { status });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json(jsonRpcError(status === 500 ? -32603 : -32600, status === 500 ? "Internal error" : "Bad request"));
  };
  app.use(onError);

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { createMcpServer } = await import("./mcp/createServer.js");
  const { bootstrap } = await import("./bootstrap.js");
  const deps = await bootstrap(config);
  const app = createApp({ authMode: config.authMode, secret: config.secret, makeServer: () => createMcpServer(deps) });
  const httpServer = app.listen(config.port, (err?: Error) => {
    if (err) {
      logError("listen_failed", err);
      process.exit(1);
    }
    log("listening", { port: config.port, authMode: config.authMode });
  });
  const shutdown = () => {
    httpServer.close(() => {
      void deps.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Startup errors are config or connection problems; their messages carry no secrets or data.
    console.error(JSON.stringify({ event: "startup_failed", message: err instanceof Error ? err.message : "unknown" }));
    process.exit(1);
  });
}
