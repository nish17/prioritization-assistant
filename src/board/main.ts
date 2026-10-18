// Unit 0 platform-check stub. Replaced by the real board in Unit 5.
import { App } from "@modelcontextprotocol/ext-apps";

const root = document.getElementById("root")!;
const line = (text: string) => {
  const p = document.createElement("p");
  p.textContent = text;
  root.append(p);
  document.documentElement.style.height = `${document.body.scrollHeight}px`;
};
const button = (label: string, onClick: () => Promise<unknown>) => {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = () => {
    onClick().then(
      (r) => line(`${label}: ok ${JSON.stringify(r).slice(0, 200)}`),
      (e) => line(`${label}: error ${String(e).slice(0, 200)}`),
    );
  };
  root.append(b);
};

const app = new App({ name: "Prioritizer board (stub)", version: "0.0.1" });
app.ontoolresult = (result) => line(`tool result: ${JSON.stringify(result.structuredContent ?? null).slice(0, 200)}`);

line("Board stub loaded.");
button("callServerTool", () => app.callServerTool({ name: "list_tasks", arguments: {} }));
button("sendMessage", () => app.sendMessage({ role: "user", content: [{ type: "text", text: "Board stub test: reply with OK." }] }));
button("fullscreen", () => app.requestDisplayMode({ mode: "fullscreen" }));
button("inline", () => app.requestDisplayMode({ mode: "inline" }));
button("openLink", () => app.openLink({ url: "https://mail.google.com/" }));

await app.connect();
const ctx = app.getHostContext();
line(`host: ${JSON.stringify(app.getHostVersion() ?? null)} displayMode=${ctx?.displayMode} available=${JSON.stringify(ctx?.availableDisplayModes ?? null)}`);
