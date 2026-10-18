# Demo script (Mon 19 Oct, 17:00 IST)

The demo follows the success criteria. Finalize the bracketed items in the 15:30 buffer, after Jeevan's backfill.

**Surface:** [web / desktop / Cowork, as chosen at the start of Jeevan's session]. **Chat:** a fresh chat with Prioritizer, Gmail, Slack, Calendar and Granola on, and web search off.

## 0. Before the call (16:45)

- [ ] Usage window is fresh. Jeevan sent one trivial message at about 10:30.
- [ ] Staged activity is ready but **not sent yet**:
  - Gmail: [co-founder] replies in the existing thread "[subject]" with a new ask: "[text]".
  - Slack: [co-founder] DMs a follow-up on the task "[title]": "[text]".
- [ ] Live-send target: a co-founder or Jeevan himself, never a client. Task: "[title]".
- [ ] One task with sources from two tools: "[title]" ([Gmail + Granola]).

## 1. The board (3 min)

"Show my board."

- Walk the four quadrants. Point at the freshness header (every source green) and the waiting count.
- Open one Do card: the reasons say who asked, when, and why it matters. Open **Details** to show the excerpt and the original link, and click through to Gmail.

## 2. Is it right? (5 min) (criteria: 8 of 10 placements, every quadrant has tasks)

- Pick 10 cards at random across the quadrants. Jeevan says agree or disagree for each. Target: 8 or more.
- For one he disagrees with: "Why is <task> in <quadrant>?" Claude explains from the rules. If it's a data problem, fix it in chat.

## 3. Coverage (3 min) (criterion: most of the 5–10 known-open items appear)

- "Check my known open items against the board." (They're saved from setup.) Count the hits.
- Show the multi-source task "[title]" with chips from [Gmail and Granola].

## 4. Second refresh, no duplicates (5 min) (criterion: no duplicates after staged activity)

1. Send the two staged messages now.
2. "Refresh my board."
3. Show the outcome summary:
   - the Gmail reply **converted** into the existing task (no new card), or Claude split it with a reason if it's a different ask
   - the Slack DM updated the existing task
4. Say it plainly: Slack DMs aren't grouped into conversations yet. Here, Claude linked the DM through `find_related`.

## 5. Act from the board (4 min) (criterion: one task acted on end to end, starting from the board)

1. On the card "[title]", press **Act**.
2. Claude drafts the reply with the exact recipient and body. Jeevan reads it and says "send".
3. The card leaves the board: waiting on others, with a follow-up date.

## 6. Close (5 min)

- What changes in production: sign-in instead of a secret URL, a PE-specific scoring profile, filters, WhatsApp when a connector exists, and a hosted, multi-user setup.
- The ask: agree to scope the paid phase.

## Fallbacks

| If | Do |
| --- | --- |
| The board doesn't render | Use the text board (`list_tasks` text) and Act from chat: "Draft a reply for task <id>". |
| Web chat doesn't call tools | Switch to desktop or Cowork (#476). |
| Usage limit is hit | Skip step 4. Show the outcome rows from the earlier refresh in Jeevan's session. |
| A refresh takes too long | Refresh only Gmail: "refresh my board, gmail only". |
