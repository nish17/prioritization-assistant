// Board state and actions, separated from the App wiring so tests can drive it with a fake host.
import { emptyState, isAllowedLink, render, type DetailsState, type Handlers, type ViewState } from "./render.js";
import { isBoard, isTaskDetails, QUADRANTS, type Board, type Quadrant } from "./types.js";

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] };

export interface Host {
  callServerTool(params: { name: string; arguments: Record<string, unknown> }): Promise<ToolResult>;
  sendMessage(params: { role: "user"; content: { type: "text"; text: string }[] }): Promise<{ isError?: boolean }>;
  openLink(params: { url: string }): Promise<{ isError?: boolean }>;
  requestDisplayMode(params: { mode: "inline" | "fullscreen" }): Promise<{ mode: string }>;
}

export interface HostContextLike {
  displayMode?: string;
  availableDisplayModes?: string[];
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
}

/** The only message the board ever sends: a fixed template carrying the task id, never task text. */
export const actMessage = (id: string) => `Draft a reply for task ${id}`;
export const REFRESH_MESSAGE = "Refresh my board";

export interface Election {
  createdAt: number;
  seq: number;
  instanceId: string;
}

/** Newer createdAt wins, then higher seq. An equal key is the same tool result mounted twice: neither yields. */
export function isYounger(other: Election, mine: Election): boolean {
  if (other.createdAt !== mine.createdAt) return other.createdAt > mine.createdAt;
  return other.seq > mine.seq;
}

const HOST_TIMEOUT_MS = 30_000;
function withTimeout<T>(p: Promise<T>, ms = HOST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function createBoard(root: HTMLElement, host: Host, opts: { onPainted?: (s: ViewState) => void } = {}) {
  const state = emptyState();
  let election: Election | null = null;
  const peers = new Map<string, Election>();
  let channel: { postMessage(m: unknown): void } | null = null;
  // Refetch sequencing: only the latest-issued list_tasks response is applied, and a Done keeps its card hidden
  // until a fetch issued after the update confirms the card is gone.
  let issued = 0;
  let inFlight: Promise<boolean> | null = null;
  const doneAt = new Map<string, number>();
  const detailTokens = new Map<string, number>();
  let detailSeq = 0;

  const paint = () => {
    state.now = new Date();
    render(root, state, handlers);
    opts.onPainted?.(state);
  };

  const errorText = (r: ToolResult) => r.content?.find((c) => c.type === "text")?.text ?? "unknown error";
  const call = (name: string, args: Record<string, unknown>) => withTimeout(host.callServerTool({ name, arguments: args }));

  function applyBoard(board: Board, seq: number) {
    // The election key never changes on refetch: it comes only from the mount-time result.
    state.board = board;
    state.loadError = null;
    const present = new Set(QUADRANTS.flatMap((q) => board.quadrants[q].cards.map((c) => c.id)));
    for (const id of [...state.hidden]) {
      if (state.pending.has(id)) continue;
      const since = doneAt.get(id);
      if (since !== undefined && seq <= since) continue; // fetched before the Done landed: stay hidden
      doneAt.delete(id);
      if (!present.has(id) || since !== undefined) state.hidden.delete(id);
    }
  }

  async function fetchOnce(): Promise<boolean> {
    const seq = ++issued;
    try {
      const r = await call("list_tasks", {});
      if (seq !== issued) return true; // a newer fetch owns the state
      if (r.isError || !isBoard(r.structuredContent)) {
        state.loadError = "Couldn't refresh the board. Ask Claude to show your board again.";
        return false;
      }
      applyBoard(r.structuredContent, seq);
      return true;
    } catch {
      if (seq === issued) state.loadError = "Couldn't refresh the board. Ask Claude to show your board again.";
      return false;
    } finally {
      if (seq === issued) paint();
    }
  }

  /** Coalesces overlapping refetches; `fresh` waits for any in-flight fetch and then issues a new one. */
  async function refetch(fresh = false): Promise<boolean> {
    if (inFlight && !fresh) return inFlight;
    if (inFlight) await inFlight.catch(() => false);
    const p = fetchOnce();
    inFlight = p;
    void p.finally(() => {
      if (inFlight === p) inFlight = null;
    });
    return p;
  }

  async function guarded(key: string, fn: () => Promise<void>) {
    if (state.busy.has(key)) return;
    state.busy.add(key);
    paint();
    try {
      await fn();
    } finally {
      state.busy.delete(key);
      paint();
    }
  }

  const handlers: Handlers = {
    async done(id) {
      if (state.superseded || state.pending.has(id)) return;
      state.pending.add(id);
      state.hidden.add(id);
      state.cardErrors.delete(id);
      paint();
      let ok = false;
      try {
        const r = await call("update_status", { task_id: id, status: "done" });
        if (r.isError) throw new Error(errorText(r));
        ok = true;
      } catch {
        state.hidden.delete(id);
        state.cardErrors.set(id, "Couldn't mark this done. Try again, or tell Claude.");
      }
      state.pending.delete(id);
      if (!ok) {
        paint();
        return;
      }
      // Stays hidden until a fetch issued after this point shows it's gone, even if that fetch fails.
      doneAt.set(id, issued);
      await refetch(true);
    },

    act(id) {
      if (state.superseded) return;
      return guarded(`act:${id}`, async () => {
        state.cardErrors.delete(id);
        try {
          const r = await withTimeout(host.sendMessage({ role: "user", content: [{ type: "text", text: actMessage(id) }] }));
          if (r.isError) throw new Error("rejected");
          state.notices.set(id, "Sent to chat. Claude will draft it there.");
        } catch {
          state.cardErrors.set(id, `Couldn't post to chat. Type: ${actMessage(id)}`);
        }
      });
    },

    async toggleDetails(id) {
      if (state.details.has(id)) {
        state.details.delete(id);
        detailTokens.delete(id);
        paint();
        return;
      }
      const token = ++detailSeq;
      detailTokens.set(id, token);
      state.details.set(id, "loading");
      paint();
      let next: DetailsState;
      try {
        const r = await call("get_task", { task_id: id });
        if (r.isError || !isTaskDetails(r.structuredContent)) throw new Error(errorText(r));
        next = r.structuredContent;
      } catch {
        next = { error: "Couldn't load details." };
      }
      if (detailTokens.get(id) !== token) return; // closed or reopened meanwhile: drop the late response
      state.details.set(id, next);
      paint();
    },

    async openLink(url) {
      if (!isAllowedLink(url)) return;
      await withTimeout(host.openLink({ url })).catch(() => undefined);
    },

    openFullscreen() {
      return guarded("fullscreen", async () => {
        try {
          const r = await withTimeout(host.requestDisplayMode({ mode: "fullscreen" }));
          state.mode = r.mode === "fullscreen" ? "fullscreen" : "inline";
        } catch {
          // stay inline
        }
      });
    },

    refresh() {
      if (state.superseded) return;
      return guarded("refresh", async () => {
        await withTimeout(host.sendMessage({ role: "user", content: [{ type: "text", text: REFRESH_MESSAGE }] })).catch(() => undefined);
      });
    },

    showMore(q: Quadrant) {
      state.expandedQuadrants.add(q);
      paint();
    },
  };

  function recompute() {
    const was = state.superseded;
    state.superseded = !!election && [...peers.values()].some((p) => isYounger(p, election!));
    if (was !== state.superseded) paint();
  }

  return {
    state,
    handlers,
    refetch: () => refetch(),
    paint,

    /** The host pushes the result of the tool call that mounted this board. */
    onToolResult(r: ToolResult, instanceId: string) {
      if (r.isError || !isBoard(r.structuredContent)) {
        state.loadError = r.isError ? "The board couldn't load. Ask Claude to show your board again." : "Unexpected board data.";
        paint();
        return;
      }
      const board: Board = r.structuredContent;
      // A late or re-delivered mount result never overwrites a board already refreshed by a fetch.
      if (!state.board || issued === 0) {
        state.board = board;
        state.loadError = null;
      }
      if (!election && board.election) {
        election = { createdAt: board.election.createdAt, seq: board.election.seq, instanceId };
        channel?.postMessage({ type: "hello", ...election });
        recompute();
      }
      paint();
    },

    onHostContext(ctx: HostContextLike) {
      if (ctx.displayMode === "fullscreen" || ctx.displayMode === "inline") state.mode = ctx.displayMode;
      if (ctx.availableDisplayModes) state.canFullscreen = ctx.availableDisplayModes.includes("fullscreen");
      if (ctx.safeAreaInsets) {
        const i = ctx.safeAreaInsets;
        root.style.padding = `${i.top}px ${i.right}px ${i.bottom}px ${i.left}px`;
      }
      paint();
    },

    /** Joins the supersession election on a shared channel (one per connector and conversation). */
    attachChannel(ch: { postMessage(m: unknown): void; onmessage: ((ev: { data: unknown }) => void) | null }) {
      channel = ch;
      ch.onmessage = (ev) => {
        const msg = ev.data as (Election & { type?: string }) | null;
        if (!msg || !election || msg.instanceId === election.instanceId) return;
        if (!Number.isFinite(msg.createdAt) || !Number.isFinite(msg.seq)) return;
        if (msg.type === "hello") ch.postMessage({ type: "born", ...election });
        peers.set(msg.instanceId, { createdAt: msg.createdAt, seq: msg.seq, instanceId: msg.instanceId });
        recompute();
      };
    },
  };
}
