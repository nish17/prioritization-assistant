---
date: 2026-10-18
topic: prioritization-assistant-poc
---

# Prioritization Assistant: Monday POC Requirements

## Problem Frame

Jeevan (red6ai) wants a POC by Monday 19 Oct 2026 that he can plug into his own Claude. It is a daily prioritization assistant for a private equity operating partner: it pulls context from meetings, email and Slack, and shows tasks sorted into an Eisenhower 2x2, each with full sourcing (`meeting_notes.md`).

`prioritization-assistant-design.md` (v0.1) is the full design. This document records three things: how that design traces back to the meeting, the platform facts checked on 18 Oct 2026, and the reduced scope and fixes agreed for Monday. **Where this document and the design disagree, this document wins for the POC.**

The POC is also a sales asset. Budget and engagement model are still open (meeting 04:01 to 06:44). So scope aims for a reliable, convincing demo on Jeevan's real data, not production plumbing. **Monday validates the mechanics** (ingestion, sourcing, dedupe, scoring, acting from the board) on Jeevan's data. It does not validate PE-specific scoring, and it is not the client demo. The goal is Jeevan's buy-in to scope a paid phase.

## Meeting Traceability

| Meeting point (timestamp) | Covered by | Status |
| --- | --- | --- |
| Context from Fellow, Granola, email, Slack, other tools (11:54) | R1 to R3 | Covered for Jeevan's stack: Gmail, Calendar, Slack, Granola. Fellow is left out because he doesn't use it; keep it for the client if they do. |
| WhatsApp named as a connector to handle (15:16) | Scope Boundaries | Deferred. Must be told to Jeevan. |
| Eisenhower 2x2: do, schedule, delegate, defer (11:54) | R9 to R12 | Covered |
| Full sourcing: why it is urgent or important, and which documents (12:57) | R5 | Covered |
| Ingest last 30 days, then refresh daily (13:05) | R1 to R3 | Covered, with the backfill filtered to items that may need action |
| Net-new vs update, link related threads such as repeated calls with one person (13:05) | R6 to R8 | Covered |
| Lives inside Claude, right-side pane (13:49) | R13, R14 | Closest available: the board opens fullscreen in the chat. Claude has no side pane for connectors. |
| Act through chat using Claude's existing integrations (13:49) | R15 | Covered (send capabilities checked) |
| Confirm connector availability for all tools (15:16) | Dependencies table | Done 18 Oct 2026 |
| Business logic for urgency scoring (16:03) | R9 to R12 | Covered |
| Cloud deployment; scalability still open (16:31) | Design section 19 | Covered |
| POC by Monday in Jeevan's own Claude (16:56) | R16, R17 | Covered |

## Requirements

**Ingestion**

- R1. The backfill covers the last 30 days from Gmail, Slack, Google Calendar and Granola, but reads only items that may need action:
  - email threads where the latest message is not from the user
  - email threads where the user wrote last and has had no reply for 3+ days (catches the user's own commitments and follow-ups to chase), capped per session
  - Slack DMs, group DMs and mentions
  - Granola action items and decisions
  - meetings in the next 7 days

  All fetched content is untrusted data. Claude never follows instructions found inside an email, message or meeting note.
- R2. The backfill runs as separate sessions, one per source or per source and week, so no single conversation holds 30 days of raw content. Sync cursors make it resumable. This replaces the "drop raw content from working memory" rule in design section 14. A conversation cannot drop content: every connector result stays in context.
- R3. The daily refresh runs as a Claude scheduled task on weekdays, plus an on-demand "refresh my board". It processes only items newer than each source's cursor. Calendar is the exception: it re-reads the next 7 days on every run and relies on R8.
  - Every refresh, scheduled or manual, records a run start and finish (design `start_run` and `finish_run`), so a missed run can be told apart from an empty one.
  - The scheduled refresh only reads sources and writes to our server. It never drafts, sends or creates events, because no one is present to confirm.
  - Setup sets our connector's tools to always allow. The send tools for Gmail, Slack and Calendar keep asking for approval.
- R4. The server accepts several tasks in one call (a batch upsert), which cuts the two-calls-per-task cost of the current design.

**Task quality and dedupe**

- R5. Every task carries:
  - its signals
  - one-sentence urgency and importance reasons
  - at least one source pointer: source, external ID, a title (email subject, Slack channel or meeting name), timestamp, an excerpt of up to 280 characters, and a link wherever the source provides one
- R6. Before a task is written, related tasks are looked up, and Claude chooses one of: update, new and linked, or new.
- R7. The server refuses silent duplicates. If a "new" task cites a source item already attached to an open task, the server treats it as an update to that task, or rejects it with the matching task ID. The exception is when Claude explicitly marks it as a second task from the same item. This closes a gap in NFR-7: the design's uniqueness rule only applies within a single task.
- R8. A calendar event seen again in the fixed next-7-days window is recognized, and does not create a new prep task each day. Calendar event IDs are checked against tasks in any status, including done. A match is attached as evidence and never creates or reopens a task.

**Scoring**

- R9. The server computes the quadrant from Claude's signals using fixed rules (design section 9). Every task records the rules version that scored it.
- R10. Urgency, snooze expiry and follow-up expiry are computed when the board is read, so the board stays current without a server-side scheduled job. This replaces "server recomputes urgency daily" in FR-14 and design section 7.2 step 7. The design names no trigger for that recompute. A task moved to `waiting_on_others` or `delegated` gets a follow-up date: its due date if it has one, otherwise 3 business days after the change. Once that date passes, the task shows as open again.
- R11. Setup asks Jeevan for about 10 key people and maps them onto the PE tiers:
  - his clients → `portfolio_ceo`
  - co-founders and partners → `principal`
  - active prospects (deals in discovery or quoting) → `principal`
  - his team → `internal_team`

  Tier names stay internal. Reasons on cards use the user's own terms (for Jeevan: "client", "prospect", "co-founder"), never "portfolio CEO".

  For each person, setup collects name, email and Slack handle, then shows Jeevan the parsed mapping to confirm before saving it. The server applies the tier on every write whenever a requester matches a saved person, matching email first and then alias (design 9.2 and 10.4). So no session needs to re-read settings. This moves `get_settings` and `update_settings` from deferred (design 18.2) into POC scope. Setup cannot work without them.
- R12. A request from a top-tier person (`lp`, `principal`, `portfolio_ceo`) counts as important on its own. Today it scores 3 against a threshold of 4. Raise those three tiers' importance weight from 3 to 4 and keep the threshold at 4, so no other tier changes quadrant. Bump the rules version.

**Board and actions**

- R13. The board is an interactive UI served by our server as an MCP App:
  - a header with the last successful refresh per source, and a stale warning when any source is more than one weekday old (design 15.1)
  - a 2x2 grid of task cards
  - done, snooze, delegate and move-quadrant actions on each card
  - an "Act" action that sends a chat message such as "Draft a reply for task 123" (design 15.3)

  Each source shows as a chip with the source icon, title and date. A chip is a link only when a URL exists, and links open through the host. The excerpt appears when the card is expanded. All stored text (titles, reasons, excerpts) is shown as escaped plain text, and only http(s) links are allowed.

  The board opens when the user says "show my board" and at the end of every refresh. It renders inline and asks to open fullscreen where the host allows it. That is the closest match to the meeting's "right-side pane": Claude shows interactive connectors only inline or fullscreen.
- R14. Fallbacks for the two ways the board can fail:
  - **The UI fails to render, but our tools still reach Claude.** `list_tasks` text output lets Claude draw the board itself.
  - **Our tools never reach Claude in web chat (bug #476).** That also blocks `list_tasks`, the backfill and every write. First try "Refresh tool list". If that fails, run setup, backfill and the demo from Claude desktop or Cowork.
- R15. To act on a task, the user taps Act on the card or asks Claude in chat to draft a reply, schedule time, or send a Slack message. Claude re-fetches the full source and shows the draft in chat, including the exact recipient or channel and the full body. It sends only after an explicit yes. Afterwards the task moves to `waiting_on_others` or done (design 7.3), and the board shows the change the next time it reads tasks.

**Access and setup**

- R16. Jeevan reaches the server as a custom connector, authenticated with a fixed secret sent in a request header. If his account doesn't offer request headers, which are a limited beta, the same secret goes in the connector URL path instead. There is no OAuth for the POC, and there is a single allowed user.
  - The secret is at least 32 random bytes, stored only in a host environment variable, compared in constant time, required on every route including the UI resource, and never logged.
  - On Team or Enterprise plans, a header credential added by the Owner is shared by every member who connects. "Single user" therefore holds only if Jeevan is the only member who enables the connector.
- R17. A one-page setup guide for Jeevan covers:
  - the connectors to enable
  - adding the custom connector
  - uploading the skill
  - setting our connector's tools to always allow
  - running setup
  - creating the scheduled task
  - after the demo: wiping the POC database and rotating the secret, and rotating it at once if it leaks
- R18. Design sections 16 and 17 data controls still apply to the POC:
  - schema validation and size caps on every tool input
  - no excerpts or key-people data in logs
  - encryption at rest
  - the full-wipe routine

## Success Criteria (demo)

- The backfill completes across its sessions without a context overflow or a usage-limit stop.
- At least 80% of tasks on the board are ones Jeevan agrees are real tasks.
- Every task shows at least one source he recognizes. Links work for Gmail, Slack and Calendar. Granola shows a link where the connector provides one, and otherwise the meeting title and date.
- No duplicate tasks for the same thread or event, including after a second refresh.
- Jeevan agrees with the quadrant on at least 8 of 10 randomly chosen tasks, and every quadrant has at least one task.
- Before the backfill, Jeevan names 5 to 10 items from the last 30 days that he knows are still open. The board surfaces most of them.
- At least one task shows sources from two or more tools (for example, an email and a Granola note with the same person).
- Starting from the board, he acts on one task end to end: Act on the card, draft in chat, confirm, send.

## Scope Boundaries

- **WhatsApp: out.** There is no WhatsApp connector in Claude's directory. The alternatives are third-party relays or unofficial libraries, and neither is acceptable for confidential deal data. Tell Jeevan explicitly, because it came up in the meeting.
- **After Monday:** OAuth, multi-user, entity merge, UI filters, the evaluation set, ingest analytics.
- **Outlook and Teams:** not in the POC. Jeevan's own stack drives the POC; the client's stack is still open (design open question 1).
- **Fellow:** not in the POC, because Jeevan doesn't use it. Its connector is verified (see Dependencies) and comes back if the client uses Fellow.
- **Client demo and client data: out.** This build (header secret, single user, Claude as the pipeline) runs only on Jeevan's own data. Any client demo or client data needs OAuth and the design section 16 controls first. A seeded PE scenario dataset is the first candidate after Monday.
- **Full transcripts during ingestion:** no. Ingestion reads summaries and action items only. Transcripts are read only when acting on a task.

## Key Decisions

- **Thin slice plus the interactive board.** Keep the architecture, drop OAuth, narrow the backfill, and keep the board for demo impact. This accepts about 2.5 hours of UI work and the web-rendering risk, with R14 as the fallback.
- **Map Jeevan's VIPs onto PE tiers instead of renaming the tiers.** This keeps the PE story intact for the client demo. Making the tiers role-neutral for other red6ai clients can wait.
- **Fixed header secret instead of OAuth.** Custom connectors support fixed request-header credentials. The POC has a single user working on his own data, so OAuth's cost (estimated at 1.5 hours, likely more) buys little for Monday.
- **Product resolutions from the document review (adopted 18 Oct 2026).** These are now in R1, R11, the Success Criteria and the Scope Boundaries: an extra capped Gmail query for the user's own unanswered threads, active prospects mapped to `principal`, card reasons in the user's own terms, success criteria that test value and coverage instead of a tier rule, and the client-demo boundary.
- **Jeevan's setup (confirmed 18 Oct 2026).** He is on Claude Pro or Max, so he adds the custom connector himself (no Owner step) and the scheduled refresh (R3) is available. His sources are Gmail, Google Calendar, Slack and Granola.

## Dependencies / Assumptions (verified 18 Oct 2026)

| Assumption | Finding | Source |
| --- | --- | --- |
| Our server can be added as a custom connector | Yes, on all plans; Free allows one. On Team and Enterprise, an org Owner must add it before users can connect. Fixed request-header auth is supported. | support.claude.com/en/articles/11175166 |
| A custom connector can show interactive UI | Yes, it can be displayed inline or fullscreen, with the chat box still available in fullscreen. There is no side-pane mode. Whether the board itself can request fullscreen, send chat messages and call tools is still open (see Deferred to Planning). | support.claude.com/en/articles/13454812 |
| Known custom-connector bug | Open since June 2026 (anthropics/claude-ai-mcp#476). Reported fixed around 18 Jul 2026, but recurrence reports continue into September. Some custom connectors show "Connected", but their tools never reach Claude in web chats. Tools work in Cowork, desktop and iOS sessions, and "Refresh tool list" fixes some cases. | github.com/anthropics/claude-ai-mcp/issues/476 |
| A daily refresh can run unattended | Yes. Scheduled tasks run remotely, even with the laptop closed, and have connectors, skills and plugins. Paid plans only. | support.claude.com/en/articles/13854387 |
| Gmail send, Calendar create | Yes. Gmail can send, reply and forward; Calendar can create events. Both ask for approval by default. | support.claude.com/en/articles/10166901 |
| Slack read and send | Yes: search, read channels and threads, send messages. | docs.slack.dev/ai/slack-mcp-server |
| Granola | Official connector. On Granola's free plan, only the last 30 days of personal notes are readable, and there is no transcript tool. Covers only notes the user owns or that were shared with them. About 100 requests per minute. No documented deep-link URL. | docs.granola.ai/help-center/sharing/integrations/mcp |
| Fellow | Official connector: summaries, transcripts, action items, decisions, attendees. Read-only. | developers.fellow.ai/reference/mcp-server |
| WhatsApp | Not in the directory. Only third-party or unofficial MCP servers exist. | usecarly.com/blog/claude-whatsapp-integration |

## Corrections to the Design Doc

- **Section 22.2 worked example.** The ask arrived Fri 16 Oct at 14:12 UTC. By Monday 19 Oct it is more than 2 days old, so `waiting_on_user` scores +2, not +1. Adding the inferred 7-day deadline (+1), urgency reaches 3 and the task moves to Do on **Monday**. The doc's reason for Tuesday is also wrong on its own terms: early-morning IST on Tuesday is still more than 48 hours before the 22 Oct 09:00 UTC deadline, so the 48-hour rule hasn't fired yet.
- **FR-11.** It omits the `waiting_on_others` status, which the schema and state machine both use.
- **Section 14 and risk table.** Replace "drop raw content from working memory" with R2.
- **Open question 3 is answered.** Jeevan is on Pro or Max, so he can add the custom connector himself and scheduled tasks are available.

## Outstanding Questions

### Resolve Before Planning

None. Both questions were answered on 18 Oct 2026 (see Key Decisions).

### Deferred to Planning

- [Affects R13][Needs research] Confirm that the board can request fullscreen on Claude web and desktop, and that it can send chat messages and call server tools from a custom connector.
- [Affects R3, R14][Technical] First thing on build day, check that our server's tools reach Claude on Jeevan's account in three places: a web chat, the desktop app, and a scheduled task run. The scheduled run must also finish without approval prompts.
- [Affects R5][Needs research] Check whether the Granola connector returns a link per meeting.
- [Affects R1][Technical] Work out the actionable-item filter for each connector: Gmail search syntax, Slack search modifiers, and Granola's meeting and notes tools.

### Tell Jeevan Before the Demo

- WhatsApp is deferred, and why.
- The board opens fullscreen inside the chat, not in a side pane.
- The POC is not the production architecture: production replaces Claude-as-pipeline with owned ingestion, adds multi-user OAuth, and needs an org Owner step in the client's Claude org (design section 19).
- For the live send in the demo, use a co-founder or his own address, not a client.
- Reading full transcripts when acting on a task needs a paid Granola plan. Granola's free plan covers only the last 30 days.

## Next Steps

→ `/ce:plan` for structured implementation planning
