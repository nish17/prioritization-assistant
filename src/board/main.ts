import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import "./styles.css";
import { createBoard } from "./controller.js";

const root = document.getElementById("root")!;
const app = new App({ name: "Prioritizer board", version: "1.0.0" }, {}, { autoResize: true });
let instanceId: string = crypto.randomUUID();

const board = createBoard(root, app, {
  // Claude sizes inline apps from the document, so set the height explicitly after every render (never 100vh).
  onPainted: (s) => {
    requestAnimationFrame(() => {
      document.documentElement.style.height = s.mode === "fullscreen" ? "" : `${document.body.scrollHeight}px`;
    });
  },
});

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  board.onHostContext(ctx);
}

// Register handlers before connecting so the mount-time result isn't missed.
app.ontoolresult = (result) => board.onToolResult(result, instanceId);
app.onhostcontextchanged = (ctx) => applyContext(ctx);

try {
  const channel = new BroadcastChannel("prioritizer-board-supersede-v1");
  board.attachChannel(channel as unknown as Parameters<typeof board.attachChannel>[0]);
} catch {
  // No BroadcastChannel: every instance stays live and shows its "as of" time.
}

board.paint();
await app.connect();
const ctx = app.getHostContext();
if (ctx?.toolInfo?.id !== undefined) instanceId = String(ctx.toolInfo.id);
board.state.canFullscreen = ctx?.availableDisplayModes ? ctx.availableDisplayModes.includes("fullscreen") : true;
applyContext(ctx);

let lastFetch = 0;
const refetchOnReturn = () => {
  if (!board.state.board || board.state.superseded || Date.now() - lastFetch < 3000) return;
  lastFetch = Date.now();
  void board.refetch();
};
window.addEventListener("focus", refetchOnReturn);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refetchOnReturn();
});
