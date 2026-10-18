# Prioritizer POC: setup guide

Two parts: **Part A** is for Jeevan, setting up his own Claude in about 20 minutes. **Part B** is for Nimesh, covering deploy, handover and clean-up.

What this POC does: Claude reads Gmail, Slack, Google Calendar and Granola through your own connectors. It writes tasks to a small private server, which scores them into an Eisenhower board (Do, Schedule, Delegate, Defer). You act on tasks from the board, and replies are drafted in chat and sent only when you say yes.

**What to know first**

- WhatsApp isn't connected. There is no Claude connector for it yet.
- The board opens inline in the chat and has an **Open board** button for fullscreen. It is not a side pane.
- Meeting transcripts need a paid Granola plan. Ingestion uses Granola's notes and action items only.
- This POC differs from production. It uses one fixed secret instead of sign-in, has one user, and has no filters.
- **The connector URL contains the secret.** Treat it like a password: don't paste it in Slack or email, and don't open it in a browser.
- Slack DMs aren't grouped into conversations yet. Each DM is its own thread, so a repeated ask in a DM may show as a separate task.

---

## Part A: Jeevan's setup

### 1. Turn on code execution

Skills need it. In Claude, open **Settings → Capabilities** and turn on **Code execution and file creation**. Leave its network access at the default (restricted).

### 2. Connect your sources

In **Settings → Connectors**, connect **Gmail**, **Google Calendar**, **Slack** and **Granola**. Use the same Google account as your work mail.

### 3. Add the Prioritizer connector

1. **Settings → Connectors → Add custom connector**.
2. Name: `Prioritizer`. URL: the `https://…/mcp/…` link Nimesh gives you (by password manager or read out on a call).
3. Authentication: **No sign-in** (no OAuth).
4. Save. Open a new chat, turn on Prioritizer in the chat's connector menu, and ask "show my board". You should see an empty board that says "No tasks yet".

If Claude on the web shows the connector but never calls its tools, use the **Claude desktop app** (or Cowork) for the rest. This is a known Claude issue (#476).

### 4. Set tool permissions

In the Prioritizer connector settings, set every tool to **Always allow** except:

- `update_settings`: leave on **Ask**. It changes who counts as a client or co-founder.
- `reset_backfill`: it is marked destructive, so Claude always asks.

For Gmail, Slack and Calendar, read and search tools can be "always allow". **Send, reply, forward and create-event tools must stay on "Ask"**, so nothing leaves your account without a yes.

### 5. Upload the skill

**Settings → Capabilities → Skills → Upload skill**, then choose `daily-prioritizer.zip`. It triggers on "set up my board", "continue backfill", "refresh my board", "show my board", "why is this in Do?" and the board's **Act** button.

### 6. Chat settings for backfill and refresh

In each backfill or refresh chat:

- turn **web search** and **web fetch** off
- turn off connectors you don't need in that chat
- optionally pick a lighter model (Sonnet or Haiku) for backfill chats, to save usage

### 7. Set up and backfill

1. New chat: **"Set up my board"**. Give about 10 key people with their email, Slack handle and relationship (client, co-founder, prospect, team, investor, other). Confirm the table, then list 5–10 things you know are open.
2. New chat: **"continue backfill"**. Claude processes one slice: one source, about one week. When it says so, **start a new chat** and say "continue backfill" again. Repeat until it says the backfill is complete (about 16 short chats for 30 days across 4 sources).
3. **"Show my board"**.

### 8. Daily use

- **"Refresh my board"** reads only what's new since the last run and closes tasks you've already answered. It never drafts or sends.
- On the board: **Done** closes a task, **Act** asks Claude to draft a reply, and **Details** shows the sources and why the task sits in its quadrant.
- **"Why is <task> in Do?"** explains the scoring.

### 9. Optional: weekday scheduled refresh

Create a scheduled task: weekdays at 07:30, prompt **"Refresh my board"**, with Prioritizer, Gmail, Slack, Calendar and Granola enabled. Set its approval mode so **actions require approval**. The refresh is read-only by design. If the scheduled run can't reach the tools (#476), run "refresh my board" by hand each morning instead.

---

## Part B: Nimesh (operator)

### Deploy (Railway)

Deploy from the clean snapshot worktree, never from a working directory with uncommitted edits:

```bash
git -C ../prioritization-assistant-deploy checkout --detach feat/prioritization-assistant-poc
cd ../prioritization-assistant-deploy
R=~/.railway/bin/railway   # or plain `railway` if it's on PATH
$R up                      # creates project + service, both named after the directory
$R add --database postgres
$R variables \
  --set "MCP_SECRET=$(npm run -s secret)" \
  --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  --set AUTH_MODE=path \
  --set POC_USER_EMAIL=you@example.com --set 'POC_USER_NAME=Your Name' \
  --set USER_TIMEZONE=Asia/Kolkata \
  --set BACKFILL_DAYS=2 --set SLICE_DAYS=1
```

**Railway never reads `.env`.** The file is gitignored, so `railway up` doesn't upload it, and the server doesn't load it anyway. Every variable has to be set on the service. Until it is, each deploy crashes at startup with `MCP_SECRET must be 64 hex characters`. Setting variables triggers a redeploy, which picks them up.

`$R variables` writes to the linked service. Run `$R status` first: it must show the app service, not Postgres. If it shows Postgres, add `--service <app service name>` to the command.

Keep the single quotes around `${{Postgres.DATABASE_URL}}`, so the shell passes it through and Railway resolves it to the **private** URL. Don't print or share the output of `$R variables` afterwards: it shows the secret.

| Variable | Value |
| --- | --- |
| `MCP_SECRET` | `npm run -s secret` (64 hex characters) |
| `AUTH_MODE` | `path` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (the **private** URL) |
| `POC_USER_EMAIL` / `POC_USER_NAME` | the user's email and name |
| `USER_TIMEZONE` | `Asia/Kolkata` |
| `BACKFILL_DAYS` / `SLICE_DAYS` | `2` / `1` for the dry run; **`30` / `7` for Jeevan** |

Then:

- Generate a public domain. The healthcheck is `/healthz`.
- Set a hard usage limit (Workspace → Usage).
- Remove Postgres's public TCP proxy after the first deploy has migrated.
- Keep the project to one member, with no log drains or APM.

The connector URL is `https://<domain>/mcp/<MCP_SECRET>`. Anything else returns a bare 404.

Check it, without the secret in shell history: `curl -s -o /dev/null -w "%{http_code}" https://<domain>/healthz` should print `200`.

### Wipe

Runs inside the service so it can reach the private database:

```bash
railway ssh            # opens a shell in the running service
npm run wipe           # prints row counts before and after; every count must be 0
```

The POC user is re-created on the next request.

### Handover (Mon 12:00–12:30), in this order

1. Delete any scheduled task on Nimesh's Claude.
2. Remove the Prioritizer connector from Nimesh's Claude.
3. `npm run wipe` (above), and check that every count is 0.
4. Set the variables for Jeevan with a **new** secret. This triggers the redeploy:
   ```bash
   $R variables --set "MCP_SECRET=$(npm run -s secret)" \
     --set BACKFILL_DAYS=30 --set SLICE_DAYS=7 \
     --set POC_USER_EMAIL=<jeevan's email> --set 'POC_USER_NAME=Jeevan'
   ```
5. Share the new connector URL by password-manager share or by reading it out on a call. **Never by Gmail or Slack.**

### After the demo, in this order

1. Jeevan deletes the scheduled task, if he made one.
2. Jeevan removes the Prioritizer connector.
3. `npm run wipe`, and check that every count is 0.
4. Rotate the secret with `$R variables --set "MCP_SECRET=$(npm run -s secret)"`, which redeploys, so the old URL is dead.
5. Verify: the old URL returns 404, and the wipe counts are 0.

If the POC isn't continuing, delete the Railway Postgres service so its backups go too. On any suspected leak of the URL, rotate immediately: new secret, redeploy, re-add the connector.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Deploy crashes with `MCP_SECRET must be 64 hex characters`, or no variables seem set | The variables are only in the local `.env`, or they went to the Postgres service. Set them on the app service with `$R variables --set …` (Deploy, above), then check them with `$R variables --service <app service name>`. Don't share that output: it shows the secret. |
| Connector won't add, or Claude starts a sign-in flow | URL must be `https://`, with no redirect, and exactly `/mcp/<secret>`. Auth must be "No sign-in". |
| Tools listed but never called on the web | Bug #476: use desktop or Cowork. |
| Board doesn't render, text only | The text summary is the fallback. Check `npm run build:board` ran in the deploy. Ask "show my board" again. |
| Every write tool asks for approval | Set the tools to Always allow (step 4). Writes are annotated non-destructive. |
| A source is never refreshed | `get_sync_state`: its backfill isn't complete. Run "continue backfill". |
| Pilot slice looks wrong | Tune the filters in the skill, or the weights in `src/domain/scoringConfig.ts` (bump `rules_version` and redeploy), then `reset_backfill(source, delete_tasks: true)` and redo the slice. |
