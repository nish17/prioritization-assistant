# Filling `upsert_task`

The server computes the quadrant from these signals. Set them from the item; don't try to steer the quadrant.

## Task fields

| Field | Rule |
| --- | --- |
| `title` | Imperative, under 90 characters, names the counterpart. Kept forever once created. |
| `kind` | `ask`, `commitment`, `decision`, `risk`, `prep`, `follow_up` (see task-definition.md) |
| `summary` | 1–2 sentences of context |
| `urgency_reason` | One plain sentence naming the person and the date: "Priya asked on Fri 16 Oct and needs it by Tuesday." |
| `importance_reason` | One plain sentence in the user's terms: "Client CEO; tied to Wednesday's board meeting." Never tier names. |
| `requester` | `{name, email}` for email, `{name, slack_id, slack_handle}` for Slack. The server matches saved people and sets their tier and label itself. |

## Signals (`task.signals`)

| Signal | Rule |
| --- | --- |
| `due_at` | The deadline. ISO with time zone (`2026-10-20T18:00:00+05:30`) or a bare date (`2026-10-20`, read as 18:00 local). For `prep`, the **meeting start**. Omit if there is none. |
| `due_confidence` | `explicit` when the sender states a date or day ("by Tuesday", "before the 25th"); `inferred` when you derive it ("before Thursday's board meeting" → Thursday morning); `none` otherwise. |
| `waiting_on_user` | `true` when someone asked the user and is waiting for them. `false` for `follow_up` (the user is waiting on others), FYI-style risks and most `prep`. |
| `ask_received_at` | The time of the message that made the ask (the origin item's time). |
| `requester_tier` | Only matters when the requester is **not** a saved person (saved people are matched by the server): `external_counterparty` for an external business contact, `vendor` for a supplier, `internal_team` for the user's own team, `unknown` for anyone else. |
| `risk_flags` | Any of `deal_risk`, `kpi_risk`, `legal`, `financial`, `board`, `people`. See user-context.md for what they mean here. Only when the item supports it. |
| `urgency_language` | `true` for "ASAP", "today", "urgent", "blocking", "EOD". |
| `delegable` | `true` when someone on the user's team could do it without the user. |
| `suggested_delegate` | The team member's name, if one obviously fits (from the saved people with relationship "team"). |
| `claude_importance` | 0–2: your judgment of strategic weight. 2 = revenue, a key client or a key hire is at stake; 1 = useful; 0 = routine. Rules stay dominant, so use it sparingly. |

## Sources

Every call has **exactly one** source with role `origin` (for `decision: "new"`) or `update` (for `decision: "update"`): the item that states or changes the ask. Everything else you attach is `evidence` (context: the calendar event for a meeting, a related note) or `resolution` (the user's own reply that closed the task, used in the refresh resolution pass).

| Field | Rule |
| --- | --- |
| `source` | `gmail`, `slack`, `gcal`, `granola` |
| `external_id` | The connector's ID for the item. See the identifier table below. Never a URL. |
| `thread_key` | Required for gmail and slack (see below). Leave it out for gcal and granola: the server fills it in. |
| `ask_index` | Set only when one item holds several asks: 1, 2, 3 in the order they appear. Granola: the action item's position in the note's action-item list (count all action items, including other people's, so numbering stays stable). Reuse the numbering `find_related` returns in `known_items`. |
| `occurred_at` | The item's own time (message sent, meeting start). ISO with time zone. |
| `title` | Email subject, meeting title, or "DM with Priya" / "#channel". |
| `url` | The deep link the connector gives (Gmail, Slack permalink, Calendar link, Granola link). Leave it out if there is none. |
| `author` | The sender's name. |
| `excerpt` | The one sentence that proves the ask, quoted, at most 280 characters. |

## Identifiers per connector

Replace the examples with the shapes recorded from the connectors on the day (`tests/fixtures/connector-samples.json`).

| Source | `external_id` | `thread_key` |
| --- | --- | --- |
| Gmail | The **message** ID of the message that holds the ask (not the thread ID) | The Gmail **thread** ID |
| Slack | `<channel_id>:<message ts>`, e.g. `D04ABC123:1760860000.002100` | `<channel_id>:<thread_ts>` for a reply in a thread; `<channel_id>:<ts>` (same as external_id) for a top-level message or DM |
| Calendar | The **event instance** ID. For a recurring meeting, use this week's instance ID, not the series ID | (server fills it in) |
| Granola | The meeting or note ID | (server fills it in) |

## Examples

New task from an email (two asks in one email → second call uses `ask_index: 2`):

```json
{
  "decision": "new",
  "run_id": "<from start_run>",
  "task": {
    "title": "Pick the ML lead finalist and tell Arjun",
    "kind": "decision",
    "signals": { "due_at": "2026-10-23", "due_confidence": "explicit", "waiting_on_user": true,
                 "ask_received_at": "2026-10-18T09:12:00+05:30", "risk_flags": ["people"], "claude_importance": 1 },
    "urgency_reason": "Arjun asked on Sun 18 Oct for a decision by Friday.",
    "importance_reason": "Co-founder decision on a senior hire.",
    "requester": { "name": "Arjun Mehta", "email": "arjun@example.com" }
  },
  "sources": [{ "source": "gmail", "external_id": "<message id>", "thread_key": "<thread id>", "ask_index": 1,
                "role": "origin", "occurred_at": "2026-10-18T09:12:00+05:30", "title": "Hiring: ML lead",
                "url": "<gmail link>", "author": "Arjun Mehta",
                "excerpt": "Need your call on the two ML lead finalists by Friday." }],
  "entities": [{ "type": "person", "name": "Arjun Mehta", "email": "arjun@example.com", "role": "requester" }]
}
```

Prep task from a calendar event:

```json
{
  "decision": "new", "run_id": "<run>",
  "task": { "title": "Prepare for Northwind discovery call with Dev", "kind": "prep",
            "signals": { "due_at": "2026-10-21T16:00:00+05:30", "due_confidence": "explicit" },
            "urgency_reason": "Call with Dev on Wed 21 Oct at 16:00.",
            "importance_reason": "Prospect in quoting; pricing will come up.",
            "requester": { "name": "Dev Kapoor", "email": "dev@northwind.example" } },
  "sources": [{ "source": "gcal", "external_id": "<event instance id>", "role": "origin",
                "occurred_at": "2026-10-21T16:00:00+05:30", "title": "Northwind discovery call", "url": "<calendar link>" }]
}
```

Update from a Slack follow-up on a task found by `find_related`:

```json
{
  "decision": "update", "task_id": "<task id>", "run_id": "<run>",
  "task": { "signals": { "urgency_language": true }, "urgency_reason": "Priya followed up on Slack on Mon 19 Oct asking for it today." },
  "sources": [{ "source": "slack", "external_id": "C04ACME:1760860000.0021", "thread_key": "C04ACME:1760860000.0021",
                "role": "update", "occurred_at": "2026-10-19T14:10:00+05:30", "title": "DM with Priya",
                "excerpt": "Any chance I can get the deck today?" }]
}
```

Resolution (refresh resolution pass), followed by `update_status(task_id, "done", note)`:

```json
{ "decision": "update", "task_id": "<task id>", "task": {},
  "sources": [{ "source": "gmail", "external_id": "<user's reply message id>", "thread_key": "<thread id>",
                "role": "resolution", "occurred_at": "2026-10-19T11:02:00+05:30", "title": "Re: Integration timeline" }] }
```
