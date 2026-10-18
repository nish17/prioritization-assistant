import { describe, expect, it } from "vitest";
import { compareTasks, scoreTask, type ScoringInput } from "../src/domain/scoring.js";
import { DEFAULT_SCORING } from "../src/domain/scoringConfig.js";
import { addBusinessDays, businessDaysSince } from "../src/domain/businessDays.js";

const TZ = "Asia/Kolkata";
const H = 3_600_000;
const at = (iso: string) => new Date(iso);

const base = (over: Partial<ScoringInput> = {}): ScoringInput => ({
  kind: "ask",
  due_at: null,
  due_confidence: "none",
  waiting_on_user: false,
  ask_received_at: null,
  requester_tier: null,
  risk_flags: [],
  urgency_language: false,
  delegable: false,
  suggested_delegate: null,
  claude_importance: null,
  quadrant_override: null,
  status: "open",
  snooze_until: null,
  follow_up_at: null,
  last_activity_at: at("2026-10-16T14:12:00Z"),
  ...over,
});

// Design 22.1 signals, with the POC's top-tier weight of 4 (R12).
const workedExample = base({
  due_at: at("2026-10-22T09:00:00Z"),
  due_confidence: "inferred",
  waiting_on_user: true,
  ask_received_at: at("2026-10-16T14:12:00Z"),
  requester_tier: "portfolio_ceo",
  risk_flags: ["board", "people"],
  claude_importance: 2,
});

describe("worked example (design 22.1, corrected 22.2)", () => {
  it("is schedule on Sun 18 Oct 07:00 IST", () => {
    const s = scoreTask(workedExample, at("2026-10-18T07:00:00+05:30"));
    expect(s.urgency).toBe(2);
    expect(s.importance).toBe(9);
    expect(s.quadrant).toBe("schedule");
  });

  it("moves to do on Mon 19 Oct 07:00 IST once the ask is over 2 days old", () => {
    const s = scoreTask(workedExample, at("2026-10-19T07:00:00+05:30"));
    expect(s.urgency).toBe(3);
    expect(s.quadrant).toBe("do");
  });
});

describe("urgency rules", () => {
  const now = at("2026-10-18T10:00:00Z");

  it("scores an explicit due date in 30 h as +3 and the same date inferred as +2", () => {
    const due = new Date(now.getTime() + 30 * H);
    expect(scoreTask(base({ due_at: due, due_confidence: "explicit" }), now).urgency).toBe(3);
    expect(scoreTask(base({ due_at: due, due_confidence: "inferred" }), now).urgency).toBe(2);
  });

  it("scores a past due date as overdue (+4)", () => {
    const s = scoreTask(base({ due_at: new Date(now.getTime() - H), due_confidence: "explicit" }), now);
    expect(s.urgency).toBe(4);
    expect(s.overdue).toBe(true);
  });

  it("counts a due date exactly 48 h out as within 48 h", () => {
    const due = new Date(now.getTime() + 48 * H);
    expect(scoreTask(base({ due_at: due, due_confidence: "explicit" }), now).urgency).toBe(3);
  });

  it("scores a due date within 7 days as +2", () => {
    const due = new Date(now.getTime() + 5 * 24 * H);
    expect(scoreTask(base({ due_at: due, due_confidence: "explicit" }), now).urgency).toBe(2);
  });

  it("scores waiting_on_user by the age of the ask", () => {
    const threeDays = base({ waiting_on_user: true, ask_received_at: new Date(now.getTime() - 72 * H) });
    const oneDay = base({ waiting_on_user: true, ask_received_at: new Date(now.getTime() - 24 * H) });
    expect(scoreTask(threeDays, now).urgency).toBe(2);
    expect(scoreTask(oneDay, now).urgency).toBe(1);
  });

  it("adds +1 for urgency language", () => {
    expect(scoreTask(base({ urgency_language: true }), now).urgency).toBe(1);
  });

  it("scores a prep task for a meeting in 20 h as +3", () => {
    const s = scoreTask(base({ kind: "prep", due_at: new Date(now.getTime() + 20 * H), due_confidence: "explicit" }), now);
    expect(s.urgency).toBe(3);
    expect(s.effective_status).toBe("open");
  });

  it("does not add due-date points to a prep task (the meeting start is not a deadline)", () => {
    const s = scoreTask(base({ kind: "prep", due_at: new Date(now.getTime() + 40 * H), due_confidence: "explicit" }), now);
    expect(s.urgency).toBe(0);
  });

  it("expires a prep task whose meeting started 1 h ago", () => {
    const s = scoreTask(base({ kind: "prep", due_at: new Date(now.getTime() - H), due_confidence: "explicit" }), now);
    expect(s.effective_status).toBe("expired");
  });
});

describe("importance rules", () => {
  const now = at("2026-10-18T10:00:00Z");

  it("makes portfolio_ceo alone important (4)", () => {
    const s = scoreTask(base({ requester_tier: "portfolio_ceo" }), now);
    expect(s.importance).toBe(4);
    expect(s.important).toBe(true);
  });

  it("keeps internal_team alone not important (2)", () => {
    const s = scoreTask(base({ requester_tier: "internal_team" }), now);
    expect(s.importance).toBe(2);
    expect(s.important).toBe(false);
  });

  it("keeps external_counterparty + board not important (3)", () => {
    const s = scoreTask(base({ requester_tier: "external_counterparty", risk_flags: ["board"] }), now);
    expect(s.importance).toBe(3);
    expect(s.important).toBe(false);
  });

  it("scores lp and principal at the top-tier weight", () => {
    expect(scoreTask(base({ requester_tier: "lp" }), now).importance).toBe(4);
    expect(scoreTask(base({ requester_tier: "principal" }), now).importance).toBe(4);
  });

  it("awards each flag group once", () => {
    expect(scoreTask(base({ risk_flags: ["deal_risk", "kpi_risk"] }), now).importance).toBe(3);
    expect(scoreTask(base({ risk_flags: ["legal", "financial"] }), now).importance).toBe(2);
  });

  it("clamps claude_importance to 0–2", () => {
    expect(scoreTask(base({ claude_importance: 7 }), now).importance).toBe(2);
    expect(scoreTask(base({ claude_importance: -3 }), now).importance).toBe(0);
  });
});

describe("quadrant, status and hints", () => {
  const now = at("2026-10-18T10:00:00Z");

  it("maps urgent/important to the four quadrants", () => {
    const urgentDue = { due_at: new Date(now.getTime() + 10 * H), due_confidence: "explicit" as const };
    expect(scoreTask(base({ ...urgentDue, requester_tier: "principal" }), now).quadrant).toBe("do");
    expect(scoreTask(base({ requester_tier: "principal" }), now).quadrant).toBe("schedule");
    expect(scoreTask(base(urgentDue), now).quadrant).toBe("delegate");
    expect(scoreTask(base(), now).quadrant).toBe("defer");
  });

  it("lets an override win and reports it", () => {
    const s = scoreTask(base({ quadrant_override: "do" }), now);
    expect(s.computed_quadrant).toBe("defer");
    expect(s.quadrant).toBe("do");
    expect(s.overridden).toBe(true);
  });

  it("returns a snoozed task to open once snooze_until has passed", () => {
    expect(scoreTask(base({ status: "snoozed", snooze_until: new Date(now.getTime() - H) }), now).effective_status).toBe("open");
    expect(scoreTask(base({ status: "snoozed", snooze_until: new Date(now.getTime() + H) }), now).effective_status).toBe("snoozed");
  });

  it("returns a waiting task to open once follow_up_at has passed", () => {
    expect(scoreTask(base({ status: "waiting_on_others", follow_up_at: new Date(now.getTime() - H) }), now).effective_status).toBe("open");
    expect(scoreTask(base({ status: "delegated", follow_up_at: new Date(now.getTime() + H) }), now).effective_status).toBe("delegated");
  });

  it("keeps done as done", () => {
    expect(scoreTask(base({ status: "done" }), now).effective_status).toBe("done");
  });

  it("hints could-delegate on a delegable do task with a suggested delegate", () => {
    const s = scoreTask(
      base({ requester_tier: "principal", urgency_language: true, waiting_on_user: true, ask_received_at: new Date(now.getTime() - 72 * H), delegable: true, suggested_delegate: "Sana" }),
      now,
    );
    expect(s.quadrant).toBe("do");
    expect(s.could_delegate).toBe(true);
  });

  it("lists the rules that fired with their points", () => {
    const s = scoreTask(workedExample, at("2026-10-18T07:00:00+05:30"));
    const total = (axis: string) => s.rules_fired.filter((r) => r.axis === axis).reduce((n, r) => n + r.points, 0);
    expect(total("urgency")).toBe(s.urgency);
    expect(total("importance")).toBe(s.importance);
    expect(s.rules_fired.every((r) => r.label.length > 0)).toBe(true);
  });

  it("carries the config's rules_version", () => {
    expect(scoreTask(base(), now).rules_version).toBe(DEFAULT_SCORING.rules_version);
  });
});

describe("ordering (design 9.6)", () => {
  const now = at("2026-10-18T10:00:00Z");
  const row = (id: string, over: Partial<ScoringInput>) => {
    const input = base(over);
    return { id, input, score: scoreTask(input, now) };
  };

  it("puts overdue first, then due date ascending, then importance, then recent activity", () => {
    const rows = [
      row("no-due-low", { last_activity_at: at("2026-10-17T00:00:00Z") }),
      row("no-due-recent", { last_activity_at: at("2026-10-18T09:00:00Z") }),
      row("no-due-important", { requester_tier: "principal" }),
      row("due-later", { due_at: at("2026-10-25T00:00:00Z"), due_confidence: "explicit" }),
      row("due-sooner", { due_at: at("2026-10-20T00:00:00Z"), due_confidence: "explicit" }),
      row("overdue", { due_at: at("2026-10-17T00:00:00Z"), due_confidence: "explicit" }),
    ];
    rows.sort((a, b) => compareTasks(a.input, a.score, b.input, b.score));
    expect(rows.map((r) => r.id)).toEqual(["overdue", "due-sooner", "due-later", "no-due-important", "no-due-recent", "no-due-low"]);
  });
});

describe("business days", () => {
  it("adds 3 business days to a Friday → Wednesday", () => {
    const fri = at("2026-10-16T10:00:00+05:30");
    const d = addBusinessDays(fri, 3, TZ);
    expect(d.toISOString()).toBe(at("2026-10-21T10:00:00+05:30").toISOString());
  });

  it("counts weekdays elapsed since a timestamp", () => {
    const fri = at("2026-10-16T17:00:00+05:30");
    expect(businessDaysSince(fri, at("2026-10-19T09:00:00+05:30"), TZ)).toBe(1);
    expect(businessDaysSince(fri, at("2026-10-20T09:00:00+05:30"), TZ)).toBe(2);
    expect(businessDaysSince(at("2026-10-19T08:00:00+05:30"), at("2026-10-19T20:00:00+05:30"), TZ)).toBe(0);
  });
});
