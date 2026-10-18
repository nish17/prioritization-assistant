# The user's world

The user is **Jeevan**, founder of **red6ai**, an AI consultancy. He has a handful of paying clients, an active pipeline of prospects in discovery and quoting, a small delivery team that is hiring junior engineers, and co-founders and partners he works with closely. His day is a mix of client delivery, selling, hiring and running the company.

Setup saves his key people with a relationship. The server uses it to weigh requests; you use the same words in reasons.

| Relationship | Who | Weight |
| --- | --- | --- |
| client | People at paying clients, especially their leaders | top |
| co-founder | Co-founders and close partners | top |
| prospect | People at companies in discovery or quoting | top (a deal is in play) |
| investor | Investors or advisors with a stake | top |
| team | red6ai employees and contractors | medium; also who he can delegate to |
| other | Anyone else saved | low |

People who aren't saved are weighed by what you set in `requester_tier` (see signals.md).

## Risk flags, in his terms

| Flag | Means for red6ai |
| --- | --- |
| `deal_risk` | A prospect deal, proposal, quote or renewal could slip or be lost (pricing questions, security questionnaires blocking a PO, a prospect going quiet) |
| `kpi_risk` | A client project is at risk: a missed milestone, a quality complaint, a launch date in doubt |
| `legal` | Contracts, MSAs, NDAs, compliance, data-protection asks |
| `financial` | Invoices, payments, approvals of spend, pricing that changes revenue |
| `board` | Board or investor meetings and the material for them (his own or a client's) |
| `people` | Hiring decisions, offers, someone leaving, team issues |

## What good looks like

- Client asks and prospect deal steps rise to the top; newsletters and FYIs never appear.
- Reasons say who asked, when, and why it matters in one sentence each.
- He can act on a task from the board without re-reading the thread.
