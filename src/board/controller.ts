// Board state and actions, separated from the App wiring so tests can drive it with a fake host.
import { emptyState, isAllowedLink, render, type Handlers, type ViewState } from "./render.js";
import { isBoard, type Board, type Quadrant, type TaskDetails } from "./types.js";

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

/** Newer createdAt wins, then higher seq, then instance id (for determinism). */
export function isYounger(other: Election, mine: Election): boolean {
  if (other.createdAt !== mine.createdAt) return other.createdAt > mine.createdAt;
  if (other.seq !== mine.seq) return other.seq > mine.seq;
  return other.instanceId > mine.instanceId;
}

export function createBoard(root: HTMLElement, host: Host, opts: { onPainted?: (s: ViewState) => void } = {}) {
  const state = emptyState();
  let election: Election | null = null;
  const peers = new Map<string, Election>();
  let channel: { postMessage(m: unknown): void } | null = null;
  let fetching: Promise<void> | null = null;

  const paint = () => {
    state.now = new Date();
    render(root, state, handlers);
    opts.onPainted?.(state);
  };

  const errorText = (r: ToolResult) => r.content?.find((c) => c.type === "text")?.text ?? "unknown error";

  async function refetch(): Promise<void> {
    if (fetching) return fetching;
    fetching = (async () => {
      try {
        const r = await host.callServerTool({ name: "list_tasks", arguments: {} });
        if (r.isError || !isBoard(r.structuredContent)) {
          state.loadError = "Couldn't refresh the board. Ask Claude to show your board again.";
        } else {
          // The election key never changes on refetch: it comes only from the mount-time result.
          state.board = r.structuredContent;
          state.loadError = null;
          for (const id of state.hidden) if (!state.pending.has(id)) state.hidden.delete(id);
        }
      } catch {
        state.loadError = "Couldn't refresh the board. Ask Claude to show your board again.";
      } finally {
        fetching = null;
        paint();
      }
    })();
    return fetching;
  }

  const handlers: Handlers = {
    async done(id) {
      if (state.superseded || state.pending.has(id)) return;
      state.pending.add(id);
      state.hidden.add(id);
      state.cardErrors.delete(id);
      paint();
      try {
        const r = await host.callServerTool({ name: "update_status", arguments: { task_id: id, status: "done" } });
        if (r.isError) throw new Error(errorText(r));
        state.pending.delete(id);
        await refetch();
        state.hidden.delete(id);
      } catch {
        state.pending.delete(id);
        state.hidden.delete(id);
        state.cardErrors.set(id, "Couldn't mark this done. Try again, or tell Claude.");
        paint();
      }
    },

    async act(id) {
      if (state.superseded) return;
      state.cardErrors.delete(id);
      try {
        const r = await host.sendMessage({ role: "user", content: [{ type: "text", text: actMessage(id) }] });
        if (r.isError) throw new Error("rejected");
        state.notices.set(id, "Sent to chat. Claude will draft it there.");
      } catch {
        state.cardErrors.set(id, `Couldn't post to chat. Type: ${actMessage(id)}`);
      }
      paint();
    },

    async toggleDetails(id) {
      if (state.details.has(id)) {
        state.details.delete(id);
        paint();
        return;
      }
      state.details.set(id, "loading");
      paint();
      try {
        const r = await host.callServerTool({ name: "get_task", arguments: { task_id: id } });
        if (r.isError) throw new Error(errorText(r));
        state.details.set(id, r.structuredContent as unknown as TaskDetails);
      } catch {
        state.details.set(id, { error: "Couldn't load details." });
      }
      paint();
    },

    async openLink(url) {
      if (!isAllowedLink(url)) return;
      await host.openLink({ url }).catch(() => undefined);
    },

    async openFullscreen() {
      try {
        const r = await host.requestDisplayMode({ mode: "fullscreen" });
        state.mode = r.mode === "fullscreen" ? "fullscreen" : "inline";
      } catch {
        // stay inline
      }
      paint();
    },

    async refresh() {
      if (state.superseded) return;
      await host.sendMessage({ role: "user", content: [{ type: "text", text: REFRESH_MESSAGE }] }).catch(() => undefined);
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
    refetch,
    paint,

    /** The host pushes the result of the tool call that mounted this board. */
    onToolResult(r: ToolResult, instanceId: string) {
      if (r.isError || !isBoard(r.structuredContent)) {
        state.loadError = r.isError ? "The board couldn't load. Ask Claude to show your board again." : "Unexpected board data.";
        paint();
        return;
      }
      const board: Board = r.structuredContent;
      state.board = board;
      state.loadError = null;
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
