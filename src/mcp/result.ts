import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import { log, logError } from "../log.js";

export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
// destructiveHint defaults to true in the MCP spec, and Claude always prompts on destructive tools,
// so every non-destructive write says so explicitly.
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

/** structuredContent for the board and clients that read it; the same data as compact JSON text for the model. */
export function ok(structured: object, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(structured) }],
    structuredContent: structured as Record<string, unknown>,
  };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Runs a tool body: caller mistakes come back as fixable errors; anything else is logged by code only. */
export async function run(name: string, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const result = await body();
    log("tool", { name, ms: Date.now() - started, ok: true });
    return result;
  } catch (err) {
    if (err instanceof ValidationError || err instanceof NotFoundError) {
      log("tool", { name, ms: Date.now() - started, ok: false, code: err.name });
      return fail(err.message);
    }
    logError("tool_error", err, { name, ms: Date.now() - started });
    return fail("Internal error. Nothing was written if this was a write; it is safe to retry.");
  }
}
