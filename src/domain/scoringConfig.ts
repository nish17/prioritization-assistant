// Design section 9 tables. Tuning = edit here, bump rules_version, redeploy:
// every task is rescored on the next read because scores are never stored.

export const REQUESTER_TIERS = [
  "lp",
  "principal",
  "portfolio_ceo",
  "portfolio_exec",
  "internal_team",
  "external_counterparty",
  "vendor",
  "unknown",
] as const;
export type RequesterTier = (typeof REQUESTER_TIERS)[number];

// Shown in explanations instead of tier names (R11: tier names stay internal).
export const TIER_LABELS: Record<RequesterTier, string> = {
  lp: "investor",
  principal: "co-founder, partner or prospect",
  portfolio_ceo: "client",
  portfolio_exec: "client executive",
  internal_team: "team",
  external_counterparty: "external contact",
  vendor: "vendor",
  unknown: "unknown sender",
};

export const RISK_FLAGS = ["deal_risk", "kpi_risk", "legal", "financial", "board", "people"] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

export interface ScoringConfig {
  rules_version: string;
  urgency: {
    overdue: number;
    within48h: number;
    within7d: number;
    inferredPenalty: number;
    waitingOld: number;
    waitingNew: number;
    waitingOldAfterHours: number;
    urgencyLanguage: number;
    prepWithin24h: number;
  };
  importance: {
    tiers: Record<RequesterTier, number>;
    /** Each group scores once, however many of its flags are set ("deal_risk or kpi_risk"). */
    flagGroups: { flags: RiskFlag[]; points: number; label: string }[];
    claudeMax: number;
  };
  thresholds: { urgent: number; important: number };
}

export const DEFAULT_SCORING: ScoringConfig = {
  // v1 = design doc tables. v2 = top tiers (lp, principal, portfolio_ceo) at 4 (R12).
  rules_version: "2",
  urgency: {
    overdue: 4,
    within48h: 3,
    within7d: 2,
    inferredPenalty: 1,
    waitingOld: 2,
    waitingNew: 1,
    waitingOldAfterHours: 48,
    urgencyLanguage: 1,
    prepWithin24h: 3,
  },
  importance: {
    tiers: {
      lp: 4,
      principal: 4,
      portfolio_ceo: 4,
      portfolio_exec: 2,
      internal_team: 2,
      external_counterparty: 1,
      vendor: 0,
      unknown: 0,
    },
    flagGroups: [
      { flags: ["deal_risk", "kpi_risk"], points: 3, label: "Deal or KPI risk" },
      { flags: ["board"], points: 2, label: "Board item" },
      { flags: ["legal", "financial"], points: 2, label: "Legal or financial" },
      { flags: ["people"], points: 1, label: "People (senior hire or departure)" },
    ],
    claudeMax: 2,
  },
  thresholds: { urgent: 3, important: 4 },
};
