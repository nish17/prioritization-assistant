# Source filters and caps

`start_run` returns the window and `query_hints`. Use them as given. If a connector rejects a form, use the fallback hint; widen, never narrow. Items slightly outside the window are fine: the server ignores repeats.

Caps keep one chat inside the usage budget. When more items match than the cap, process the newest up to the cap and send `capped: true` to `finish_run`. The server then splits the window and the next chat covers the rest.

## Gmail (cap: about 15 threads per run)

**(a) Asks waiting on the user, in the window.** Search with the `window` hint (epoch seconds; fallback `window_by_date`) plus:

```
<window> -in:sent -in:chats -category:promotions -category:social -category:forums -category:updates
```

Keep threads where the latest message is **not** from the user and the user is in To or Cc. Read the latest 3 messages of each thread at most. Skip newsletters, notifications and automated senders (no-reply addresses, "unsubscribe" footers).

**(b) The user's threads awaiting a reply** (only when `query_hints.sent_awaiting_reply` is present: the last backfill slice, and every refresh). This one is an explicit exception to the window rule: it looks back 30 days.

```
<sent_awaiting_reply>
```

Keep threads where the **user wrote the latest message**, it was sent 3 or more days ago, and nobody has replied since. Write each as `kind: "follow_up"`, `waiting_on_user: false`, title "Chase <person> on <topic>". Cap about 15.

**Resolution pass (refresh only):** `own_replies_since_window_start` lists the user's sent messages. Use only the thread IDs that also appear in `get_sync_state.open_thread_keys.gmail`.

## Slack (cap: about 40 messages per run)

Direct messages, group DMs, and messages that mention the user, within the window. Start with the `window` hint (date modifiers, already widened by a day each side) and the connector's search for DMs and mentions. **Confirm the exact query in the first session** (record it in `tests/fixtures/connector-samples.json`). Skip bot messages and channel chatter that doesn't mention the user.

Each top-level DM is its own thread (`channel:ts`). Repeated asks in a DM conversation are linked only through `find_related` and your judgment. When a DM follows up on an existing task, prefer `decision: "update"` with that task's id.

**Resolution pass (refresh only):** `own_replies_since_window_start` (`from:me ...`), intersected with `open_thread_keys.slack`.

## Google Calendar (no cap: the window is the next 7 days)

List events between `time_min` and `time_max`. Write a `prep` task only for events that need preparation:

- external attendees, or a saved client, prospect or investor attends; or
- the title suggests a board, investor, pricing, proposal or review meeting.

Skip: declined events, all-day events, events with no other attendees (focus blocks), routine internal standups. For a recurring meeting, one task per instance that qualifies, using that instance's ID. `due_at` = event start. The server drops prep tasks once the meeting has started.

If a meeting relates to an existing task (`find_related` by attendee email or title), attach the event as `evidence` on that task with `decision: "update"` instead of creating a separate prep task, unless real preparation is needed.

## Granola (cap: about 8 meetings per run)

List meetings in the window (`from_date` to `to_date`). If the connector can't filter by date, list recent meetings and keep only those dated inside the window.

From each meeting's **summary and action items** (never the full transcript):

- each action item assigned to the user, or clearly theirs → one task, `ask_index` = its position in the note's action-item list (1-based, counting every action item);
- each decision the user still owns → `kind: "decision"`.

Skip action items assigned to other people, and meetings with no action items or decisions. Transcripts are read only in act mode, and only if the user asks.
