// Pure DOM rendering for the board. Every string from the server goes through textContent:
// never innerHTML, never an href. Links open through the host (openLink) and only for allowed hosts.
import { QUADRANTS, type Board, type Card, type Chip, type Quadrant, type Source, type TaskDetails } from "./types.js";

export interface Handlers {
  done(id: string): void;
  act(id: string): void;
  toggleDetails(id: string): void;
  openLink(url: string): void;
  openFullscreen(): void;
  refresh(): void;
  showMore(q: Quadrant): void;
}

export type DetailsState = TaskDetails | "loading" | { error: string };

export interface ViewState {
  board: Board | null;
  loadError: string | null;
  mode: "inline" | "fullscreen";
  canFullscreen: boolean;
  superseded: boolean;
  hidden: Set<string>;
  pending: Set<string>;
  cardErrors: Map<string, string>;
  notices: Map<string, string>;
  details: Map<string, DetailsState>;
  expandedQuadrants: Set<Quadrant>;
  now: Date;
}

export const INLINE_PER_QUADRANT = 3;
export const FULLSCREEN_PER_QUADRANT = 8;

const QUADRANT_LABELS: Record<Quadrant, [string, string]> = {
  do: ["Do", "Urgent and important"],
  schedule: ["Schedule", "Important, not urgent"],
  delegate: ["Delegate", "Urgent, less important to you"],
  defer: ["Defer", "Neither"],
};
const SOURCE_LABELS: Record<Source, string> = { gmail: "Gmail", slack: "Slack", gcal: "Calendar", granola: "Granola" };

export function emptyState(): ViewState {
  return {
    board: null,
    loadError: null,
    mode: "inline",
    canFullscreen: false,
    superseded: false,
    hidden: new Set(),
    pending: new Set(),
    cardErrors: new Map(),
    notices: new Map(),
    details: new Map(),
    expandedQuadrants: new Set(),
    now: new Date(),
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string | null): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.disabled = disabled;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!b.disabled) onClick();
  });
  return b;
}

/** Mirrors the server's allow-list: https on Gmail, Calendar, Slack or Granola hosts only. */
export function isAllowedLink(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
    const h = u.hostname.toLowerCase();
    if (h === "mail.google.com" || h === "calendar.google.com") return true;
    if (h === "www.google.com") return u.pathname.startsWith("/calendar/");
    if (h === "slack.com" || h.endsWith(".slack.com")) return true;
    return ["granola.ai", "granola.so"].some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function fmtDate(iso: string, tz: string, withTime = false): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz, weekday: "short", day: "numeric", month: "short" };
  if (withTime) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
  return new Intl.DateTimeFormat("en-GB", opts).format(new Date(iso));
}

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function ago(iso: string, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function renderHeader(s: ViewState, b: Board, h: Handlers): HTMLElement {
  const header = el("header", "board-header");
  const top = el("div", "header-top");
  const title = el("div", "header-title");
  title.append(el("h1", "title", "Priorities"), el("span", "as-of", `as of ${fmtTime(b.generated_at, b.timezone)}`));
  top.append(title);
  const actions = el("div", "header-actions");
  actions.append(button("Refresh", "btn btn-ghost", h.refresh, s.superseded));
  if (s.mode === "inline" && s.canFullscreen) actions.append(button("Open board", "btn btn-primary", h.openFullscreen));
  top.append(actions);
  header.append(top);

  const fresh = el("div", "freshness");
  for (const src of b.header.sources) {
    const pill = el("span", "pill");
    const name = SOURCE_LABELS[src.source];
    if (!src.backfill_complete && !src.last_success_at) {
      pill.classList.add("pill-muted");
      pill.textContent = `${name}: not loaded`;
    } else if (src.stale) {
      pill.classList.add("pill-stale");
      pill.textContent = `${name}: stale${src.last_success_at ? ` (${fmtDate(src.last_success_at, b.timezone)})` : ""}`;
    } else if (!src.backfill_complete) {
      pill.textContent = `${name}: loading history`;
    } else {
      pill.textContent = `${name}: ${src.last_success_at ? ago(src.last_success_at, s.now) : "ok"}`;
    }
    fresh.append(pill);
  }
  header.append(fresh);

  const c = b.header.counts;
  const parked = [
    c.waiting_on_others ? `${c.waiting_on_others} waiting on others` : "",
    c.delegated ? `${c.delegated} delegated` : "",
    c.snoozed ? `${c.snoozed} snoozed` : "",
  ].filter(Boolean);
  if (parked.length) header.append(el("div", "parked", parked.join(" · ")));
  return header;
}

function renderChip(chip: Chip, tz: string, h: Handlers, disabled: boolean): HTMLElement {
  const label = `${SOURCE_LABELS[chip.source]} · ${chip.title ?? "item"} · ${fmtDate(chip.occurred_at, tz)}`;
  if (isAllowedLink(chip.url)) {
    const url = chip.url;
    const b = button(label, `chip chip-${chip.source} chip-link`, () => h.openLink(url), disabled);
    b.title = "Open the original";
    return b;
  }
  return el("span", `chip chip-${chip.source}`, label);
}

function renderDetails(d: DetailsState, tz: string, h: Handlers, disabled: boolean): HTMLElement {
  const box = el("div", "details");
  if (d === "loading") {
    box.append(el("div", "skeleton"), el("div", "skeleton short"));
    return box;
  }
  if ("error" in d) {
    box.append(el("p", "card-error", d.error));
    return box;
  }
  if (d.task.summary) box.append(el("p", "summary", d.task.summary));
  const why = d.task.rules_fired.map((r) => `${r.label} +${r.points}`).join(" · ");
  if (why) box.append(el("p", "why", `Why: ${why}`));
  if (d.task.status_note) box.append(el("p", "note", `Note: ${d.task.status_note}`));
  const list = el("ul", "source-list");
  for (const src of d.sources) {
    const li = el("li", "source-item");
    const head = el("div", "source-head");
    head.append(el("span", `chip chip-${src.source}`, SOURCE_LABELS[src.source]));
    head.append(el("span", "source-title", src.title ?? "item"));
    if (src.occurred_at) head.append(el("span", "source-date", fmtDate(src.occurred_at, tz, true)));
    if (src.role !== "origin") head.append(el("span", "source-role", src.role));
    li.append(head);
    if (src.untrusted_excerpt) {
      const q = el("blockquote", "excerpt", src.untrusted_excerpt);
      q.title = "Quoted from the source";
      li.append(q);
    }
    if (src.untrusted_author) li.append(el("div", "source-author", `From ${src.untrusted_author}`));
    if (isAllowedLink(src.url)) {
      const url = src.url;
      li.append(button("Open original", "btn btn-link", () => h.openLink(url), disabled));
    }
    list.append(li);
  }
  box.append(list);
  return box;
}

function renderCard(card: Card, s: ViewState, b: Board, h: Handlers): HTMLElement {
  const pending = s.pending.has(card.id);
  const disabled = s.superseded || pending;
  const node = el("article", "card");
  node.dataset.taskId = card.id;
  if (card.overdue) node.classList.add("overdue");
  if (pending) node.classList.add("pending");

  node.append(el("div", "card-title", card.title));

  const meta = el("div", "card-meta");
  if (card.due_at) meta.append(el("span", card.overdue ? "tag tag-danger" : "tag", `${card.overdue ? "Overdue" : "Due"} ${fmtDate(card.due_at, b.timezone)}`));
  if (card.requester && (card.requester.name || card.requester.label)) {
    meta.append(el("span", "tag tag-person", [card.requester.name, card.requester.label].filter(Boolean).join(" · ")));
  }
  if (card.follow_up_due) meta.append(el("span", "tag tag-warning", "Follow-up due"));
  if (card.could_delegate && card.suggested_delegate) meta.append(el("span", "tag tag-info", `Could delegate to ${card.suggested_delegate}`));
  if (card.overridden) meta.append(el("span", "tag", "Moved by you"));
  if (meta.childElementCount) node.append(meta);

  if (card.reasons.urgency) node.append(el("p", "reason", card.reasons.urgency));
  if (card.reasons.importance) node.append(el("p", "reason", card.reasons.importance));

  if (card.sources.length) {
    const chips = el("div", "chips");
    for (const chip of card.sources) chips.append(renderChip(chip, b.timezone, h, s.superseded));
    if (card.source_count > card.sources.length) chips.append(el("span", "chip chip-more", `+${card.source_count - card.sources.length}`));
    node.append(chips);
  }

  const err = s.cardErrors.get(card.id);
  if (err) node.append(el("p", "card-error", err));
  const notice = s.notices.get(card.id);
  if (notice) node.append(el("p", "card-notice", notice));

  const actions = el("div", "actions");
  actions.append(button("Done", "btn", () => h.done(card.id), disabled));
  actions.append(button("Act", "btn btn-primary", () => h.act(card.id), disabled));
  const open = s.details.has(card.id);
  const toggle = button(open ? "Hide details" : "Details", "btn btn-ghost", () => h.toggleDetails(card.id), s.superseded);
  toggle.setAttribute("aria-expanded", String(open));
  actions.append(toggle);
  node.append(actions);

  const d = s.details.get(card.id);
  if (d) node.append(renderDetails(d, b.timezone, h, s.superseded));
  return node;
}

function renderQuadrant(q: Quadrant, s: ViewState, b: Board, h: Handlers): HTMLElement {
  const data = b.quadrants[q];
  const visible = data.cards.filter((c) => !s.hidden.has(c.id));
  const hiddenCount = data.cards.length - visible.length;
  const total = Math.max(0, data.total - hiddenCount);
  const section = el("section", `quadrant quadrant-${q}`);
  section.dataset.quadrant = q;
  const head = el("div", "quadrant-head");
  const [label, sub] = QUADRANT_LABELS[q];
  const titleRow = el("div", "quadrant-title");
  titleRow.append(el("h2", undefined, label), el("span", "count", String(total)));
  head.append(titleRow, el("div", "quadrant-sub", sub));
  section.append(head);

  const cap = s.mode === "inline" ? INLINE_PER_QUADRANT : s.expandedQuadrants.has(q) ? visible.length : FULLSCREEN_PER_QUADRANT;
  const shown = visible.slice(0, cap);
  if (!shown.length) section.append(el("p", "quadrant-empty", "Nothing here."));
  for (const card of shown) section.append(renderCard(card, s, b, h));

  const notShownHere = total - shown.length;
  if (notShownHere > 0) {
    if (s.mode === "fullscreen" && visible.length > shown.length) {
      section.append(button(`Show ${visible.length - shown.length} more`, "btn btn-ghost more", () => h.showMore(q)));
    } else if (s.mode === "inline") {
      section.append(el("p", "more-note", `+${notShownHere} more in the full board`));
    } else {
      section.append(el("p", "more-note", `+${notShownHere} more. Ask Claude to list them.`));
    }
  }
  return section;
}

export function render(root: HTMLElement, s: ViewState, h: Handlers): void {
  const app = el("div", `board mode-${s.mode}`);
  if (s.superseded) {
    app.classList.add("superseded");
    app.append(el("div", "banner", "A newer board is further down the conversation. This one is read-only."));
  }

  if (s.loadError && !s.board) {
    app.append(el("div", "state state-error", s.loadError));
    root.replaceChildren(app);
    return;
  }
  if (!s.board) {
    const loading = el("div", "state");
    loading.append(el("div", "skeleton"), el("div", "skeleton"), el("div", "skeleton short"));
    app.append(loading);
    root.replaceChildren(app);
    return;
  }

  const b = s.board;
  app.append(renderHeader(s, b, h));
  if (s.loadError) app.append(el("div", "inline-error", s.loadError));

  const c = b.header.counts;
  const anyCards = QUADRANTS.some((q) => b.quadrants[q].cards.some((card) => !s.hidden.has(card.id)));
  if (!anyCards) {
    const parked = c.waiting_on_others + c.delegated + c.snoozed;
    app.append(
      el(
        "div",
        "state state-empty",
        parked > 0 ? `Nothing needs you right now. ${parked} task${parked === 1 ? " is" : "s are"} parked.` : "No tasks yet. Say 'Set up my board'.",
      ),
    );
    root.replaceChildren(app);
    return;
  }

  const grid = el("div", "grid");
  for (const q of QUADRANTS) grid.append(renderQuadrant(q, s, b, h));
  app.append(grid);
  root.replaceChildren(app);
}
