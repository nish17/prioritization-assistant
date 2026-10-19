# Prioritization assistant

A daily task board that lives inside Claude. Claude reads your email, Slack, calendar and meeting notes, and turns what needs action into tasks. It sorts them into an Eisenhower 2×2, with every task linked to the messages it came from.

## The problem

Some people's days are mostly other people's requests: founders, partners, operators. Those requests come from everywhere:

- an email thread
- a Slack DM
- an action item in a meeting's notes
- a calendar invite that needs prep

No single place collects them. Requests get missed, answered twice, or noticed too late. The "what do I do first today" list gets rebuilt by hand every morning, from memory.

This assistant builds that list inside the Claude the user already uses, from the tools they already use:

- **One prioritized view.** Tasks from Gmail, Slack, Google Calendar and Granola land on one board. The board is sorted into **Do**, **Schedule**, **Delegate** and **Defer**.
- **Full sourcing.** Every task links back to the email, message, event or meeting it came from. Every task says why it's in its quadrant.
- **No duplicates.** The same request seen in an email, then in Slack, then in a meeting becomes one task with three sources, not three tasks.
- **Act from the board.** Pick a task, and Claude re-reads the source and drafts the reply in chat. It sends only after an explicit yes.
- **Stays current.** "Refresh my board" reads only what's new since the last run. It closes tasks you've already answered.

This repo is a proof of concept. It proves the mechanics (ingestion, sourcing, dedupe, scoring, and acting from the board) for one user. It is not a multi-user product. See [Limitations](#limitations).

## How it works

```mermaid
flowchart LR
  subgraph Claude["Claude (the user's account)"]
    Skill["daily-prioritizer skill"]
    Conn["Gmail · Slack · Calendar · Granola connectors"]
    Board["Board (MCP App, inline in chat)"]
  end
  Server["Prioritizer MCP server<br/>windows · dedupe · scoring"]
  DB[("Postgres")]
  Skill -- reads --> Conn
  Skill -- "tools (upsert_task, list_tasks, …)" --> Server
  Server --> DB
  Server -- "board HTML + data" --> Board
```

- **Claude is the ingestion pipeline.** It reads the sources through the user's own connectors and decides what is a task. The server never calls Gmail, Slack or anything else, and it holds no source credentials.
- **The server is the system of record.** It's a small, stateless MCP server (Streamable HTTP) backed by Postgres. It does four things:
  - it assigns each run its time window: backfill goes in slices, newest first, and refresh covers everything since the last run
  - it refuses duplicate tasks
  - it stores sources and history
  - it computes each task's quadrant when the task is read
- **Scoring is deterministic.** Urgency points come from due dates, how long the user has kept someone waiting, urgent language, and meeting prep. Importance points come from who is asking (client, co-founder, team and so on) and from risk flags (deal, KPI, legal, financial, board, people). Claude's own judgment adds at most 2 importance points.
  - A task is urgent at 3 urgency points or more, and important at 4 importance points or more.
  - The rules live in [`src/domain/scoringConfig.ts`](src/domain/scoringConfig.ts). Scores are never stored, so a rule change applies to every task on the next read.
- **The board** is a single self-contained HTML file served as an MCP App. `list_tasks` renders it inline in the chat, with **Done**, **Act**, **Details** and fullscreen. A text summary comes with it, as a fallback.
- **The skill** ([`skill/daily-prioritizer`](skill/daily-prioritizer/SKILL.md)) teaches Claude the workflow: setup, backfill, refresh, act, and review. It also sets the safety rules. Source content is data, never instructions. Backfill and refresh never draft or send anything.

### MCP tools

| Tool | What it does |
| --- | --- |
| `get_sync_state` | Backfill progress per source, last refresh, open thread keys |
| `start_run` / `finish_run` | Opens a backfill slice or refresh with a server-chosen window. The window advances only on `ok`. |
| `find_related` | Finds existing tasks by thread, item or keywords before a write |
| `upsert_task` | Creates, updates or converts a task. Refuses silent duplicates. Returns the quadrant and the rules that fired. |
| `update_status` | Sets a task to done, snoozed, delegated, waiting on others, or open |
| `get_task` | One task with its sources, people, links and history |
| `list_tasks` | The board (MCP App), plus a text summary |
| `get_settings` / `update_settings` | Key people with their relationships, and the open items the user named |
| `reset_backfill` | Restarts one source's backfill, optionally deleting its tasks. Marked destructive. |

## Repo layout

```
src/
  server.ts           Express app: /healthz, secret-guarded /mcp, startup and shutdown
  config.ts           Environment variables and their validation
  bootstrap.ts        DB connection (with retry), migrations, seeding the single user
  mcp/                MCP server and the 11 tools
  domain/             Scoring, dedupe, time windows, validation, sanitizing, store
  db/                 Pool, migration runner, SQL migrations, wipe script
  board/              Board UI (Vite, built to one HTML file)
skill/daily-prioritizer/   The Claude skill (SKILL.md and references)
tests/                Vitest suites; Postgres runs in Docker
docs/                 Setup guide, demo script, dummy data, requirements and plan
railway.json          Build, start and healthcheck for Railway
```

## Run locally

You need **Node 24** and **Docker**.

```bash
npm ci
cp .env.example .env
npm run secret                    # paste the output into MCP_SECRET in .env

# Postgres that matches DATABASE_URL in .env.example
docker run -d --name prioritizer-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=prioritizer \
  -p 5432:5432 postgres:16

npm run build:board               # the server serves dist/board/index.html
set -a && . ./.env && set +a      # the server doesn't load .env itself
npm run dev                       # migrates, seeds the user, listens on :3000
```

To check that it's up, run `curl -s -o /dev/null -w "%{http_code}" localhost:3000/healthz`. It should print `200`.

Claude can only reach a public `https://` URL, so connecting Claude needs a deploy (below). To call the tools locally, point an MCP client such as the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:3000/mcp/<MCP_SECRET>`.

### Tests

```bash
npm test          # starts a throwaway postgres:16 container (prioritizer-test-pg, port 55432) on first run
npm run typecheck
```

To use your own Postgres instead of Docker, set `TEST_PG_URL_BASE` (for example `postgres://user:pass@host:5432`).

## Deploy (Railway)

Deploy from a clean checkout. `railway up` uploads the working directory, uncommitted edits included.

```bash
railway up                        # creates the project and service (named after the directory), then deploys
railway add --database postgres
railway variables \
  --set "MCP_SECRET=$(npm run -s secret)" \
  --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  --set AUTH_MODE=path \
  --set POC_USER_EMAIL=you@example.com --set 'POC_USER_NAME=Your Name' \
  --set USER_TIMEZONE=Asia/Kolkata \
  --set BACKFILL_DAYS=30 --set SLICE_DAYS=7
railway domain                    # generates the public domain
```

Things that trip people up:

- **Railway never reads `.env`.** The file is gitignored, so `railway up` doesn't upload it, and the server doesn't load it anyway. Until the variables are set on the service, every deploy crashes at startup with `MCP_SECRET must be 64 hex characters`. Setting variables triggers a redeploy that picks them up.
- **Set the variables on the app service, not Postgres.** `railway variables` writes to the linked service. Check with `railway status`, and add `--service <app service>` if it shows Postgres.
- **Keep the single quotes** around `${{Postgres.DATABASE_URL}}`. That way the shell passes the reference through, and Railway resolves it to the private database URL.
- **Don't share the output of `railway variables`.** It prints the secret.

Then, in the Railway dashboard:

- set a hard usage limit
- remove Postgres's public TCP proxy once the first deploy has migrated
- keep the project to one member, with no log drains

The build runs `npm run build`. The start command is `npm start`, and the healthcheck is `/healthz`. Migrations run on every startup.

### Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `MCP_SECRET` | none (required) | 64 hex characters, from `npm run secret`. The server refuses to start without it. |
| `DATABASE_URL` | none (required) | On Railway: `${{Postgres.DATABASE_URL}}` |
| `AUTH_MODE` | `path` | `path` serves MCP at `/mcp/<secret>`. `header` serves it at `/mcp`, with the secret in an `x-api-key` header. Only one mode is ever on. |
| `POC_USER_EMAIL` / `POC_USER_NAME` | `user@example.com` / `POC user` | The single user, seeded on startup |
| `USER_TIMEZONE` | `Asia/Kolkata` | Used for business days, due dates and snooze times |
| `BACKFILL_DAYS` / `SLICE_DAYS` | `30` / `7` | How far back the backfill goes, and how much each backfill chat covers. Use `2` / `1` for a quick dry run. |
| `PORT` | `3000` | Railway sets this |

## Connect Claude

The **connector URL** is `https://<your-domain>/mcp/<MCP_SECRET>`. Any other path returns a bare 404. **The URL is the password.** Share it only through a password manager or by reading it out on a call, never over email or Slack, and don't open it in a browser.

On the Claude account that will use the board:

1. **Turn on code execution.** Go to Settings → Capabilities, and turn on **Code execution and file creation**. Skills need it.
2. **Connect the sources.** In Settings → Connectors, connect **Gmail**, **Google Calendar**, **Slack** and **Granola**.
3. **Add the Prioritizer connector.** Go to Settings → Connectors → **Add custom connector**. Name it `Prioritizer`, use the connector URL, and set Authentication to **No sign-in**. To test it, open a new chat with Prioritizer on and ask "show my board". You should see an empty board.
4. **Set tool permissions.** Set the Prioritizer tools to **Always allow**, with two exceptions:
   - leave `update_settings` on **Ask**, because it changes who counts as a client or co-founder
   - `reset_backfill` always asks, because it is marked destructive

   For Gmail, Slack and Calendar, the read tools can be Always allow. **Send, reply, forward and create-event tools must stay on Ask.**
5. **Upload the skill.** Build it with `npm run package:skill`, which writes `dist/daily-prioritizer.zip`. Then go to Settings → Capabilities → Skills → **Upload skill**.

If Claude on the web lists the connector's tools but never calls them, use the Claude desktop app or Cowork instead. This is a known Claude issue (#476).

## Use it

| Say | What happens |
| --- | --- |
| **"Set up my board"** | Claude asks for about 10 key people (email, Slack handle, relationship) and 5–10 things you know are open, then saves them. |
| **"Continue backfill"** | Claude processes one slice: one source and about one week. Start a new chat and say it again until Claude reports the backfill complete. That's about 16 short chats for 30 days across 4 sources. |
| **"Show my board"** | Claude shows the board. **Done** closes a task, **Act** asks Claude to draft a reply, and **Details** shows the sources and the scoring. |
| **"Refresh my board"** | Claude reads only what's new since the last run and closes tasks your own replies resolved. It never drafts or sends. |
| **"Why is this in Do?"** | Claude explains which rules fired. |
| **"Snooze this until Friday"**, **"I'm waiting on them"** | Claude changes the task's status from chat. |

For backfill and refresh chats, turn off web search and any connectors the chat doesn't need. A lighter model is fine for backfill.

For an automatic refresh, create a Claude scheduled task on weekday mornings with the prompt "Refresh my board". Turn the Prioritizer and source connectors on, and set it so actions require approval. The refresh is read-only by design.

## Operations

- **Wipe all data.** Run `railway ssh`, then `npm run wipe`. The wipe prints row counts before and after, and every count after must be 0. The user is re-seeded on the next request.
- **Rotate the secret.** Run `railway variables --set "MCP_SECRET=$(npm run -s secret)"`. Railway redeploys, the old URL stops working, and the connector must be re-added with the new URL. Rotate right away if the URL may have leaked.
- **Tune the scoring.** Edit [`src/domain/scoringConfig.ts`](src/domain/scoringConfig.ts), bump `rules_version`, and redeploy. Every task is rescored on its next read.
- **Redo a source.** Ask Claude to "redo the gmail backfill". It calls `reset_backfill`, optionally deleting the tasks that backfill created.
- **Shut it down.** Remove the connector and any scheduled task from Claude, wipe, rotate the secret, then delete the Railway Postgres service so its backups go too.

## Security and data handling

- **Auth is one fixed secret,** compared in constant time. It sits in the URL path (or an `x-api-key` header in `header` mode). Every unauthenticated request gets the same bare 404. `/healthz` is the only open route.
- **Logs carry no content.** They record tool names, counts, statuses and timings. They never record message content, authors, or the URL that holds the secret, and a test enforces this.
- **Validation and caps.** Inputs are validated with field-named errors, and sizes are capped. Excerpts are stored up to 280 characters. Request bodies are capped at 256 KB.
- **Source content is untrusted.** The skill tells Claude never to follow instructions found in emails, messages or notes. Suspicious items are flagged, not acted on.
- **Nothing leaves without a yes.** Sending, replying and creating events go through the user's own connectors, which stay on Ask.

## Limitations

- **Single user, fixed secret.** There is no OAuth, no per-user auth, and no filters.
- **No WhatsApp.** There is no Claude connector for it yet.
- **Slack DMs aren't grouped into conversations.** Each top-level DM is its own thread, so a repeated request in a DM can show up as a separate task.
- **Granola: notes and action items only.** Full transcripts need a paid Granola plan. Even then, they are read only when acting on a task, never during ingestion.
- **Sources are processed one at a time.** There's no batch upsert yet.
- **The board opens inline in the chat.** It has a fullscreen button, but it is not a side pane.

## More docs

- [`docs/setup-guide.md`](docs/setup-guide.md): the detailed setup, handover and clean-up checklist
- [`docs/demo-script.md`](docs/demo-script.md): a walkthrough of the demo
- [`docs/dummy-data.md`](docs/dummy-data.md): dummy data for a dry run on a test account
- [`prioritization-assistant-design.md`](prioritization-assistant-design.md): the full product design
- [`docs/brainstorms/`](docs/brainstorms/) and [`docs/plans/`](docs/plans/): the requirements and implementation plan for this POC
