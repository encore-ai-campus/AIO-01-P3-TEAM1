// 가짜 API의 투자 성향·경험 진단 점수표 (docs/API.md "투자자 프로필과 주린이모드" 표 그대로 — 서버 accounts/assessment.py와 같은 규칙).
import type { ExperienceLevel, InvestorAnswers, RiskProfile } from "../api/types";

const SCALE = {
  q1: { none: 0, under_1y: 1, "1_3y": 2, over_3y: 3 },
  q3: { never: 0, yearly: 1, monthly: 2, daily: 3 },
  q4: { unknown: 0, heard: 1, explain: 2 },
  q5: { no_loss: 0, loss_10: 1, loss_20: 2, more: 3 },
  q6: { years: 0, weeks: 1, intraday: 2 },
  q7: { practice: 0, growth: 1, short_term: 2 },
} as const;

const PRODUCTS = ["deposit", "fund_etf", "kr_stock", "us_stock", "derivatives"] as const;
const KEYS = ["q1", "q2", "q3", "q4", "q5", "q6", "q7"] as const;

export interface Assessment {
  experienceScore: number;
  experienceLevel: ExperienceLevel;
  riskScore: number;
  riskProfile: RiskProfile;
  recommendedBeginnerMode: boolean;
}

export function assess(a: InvestorAnswers): Assessment {
  const q2Exp = Math.min(3, (a.q2.includes("kr_stock") ? 1 : 0) + (a.q2.includes("us_stock") ? 1 : 0) + (a.q2.includes("derivatives") ? 2 : 0));
  const experienceScore = SCALE.q1[a.q1] + SCALE.q3[a.q3] + SCALE.q4[a.q4] + q2Exp;
  const riskScore = SCALE.q5[a.q5] + SCALE.q6[a.q6] + SCALE.q7[a.q7] + (a.q2.includes("derivatives") ? 1 : 0);
  const experienceLevel: ExperienceLevel =
    experienceScore <= 2 ? "intro" : experienceScore <= 5 ? "novice" : experienceScore <= 8 ? "intermediate" : "expert";
  const riskProfile: RiskProfile =
    riskScore <= 1 ? "stable" : riskScore <= 3 ? "stable_seeking" : riskScore <= 5 ? "neutral" : riskScore === 6 ? "active" : "aggressive";
  return {
    experienceScore,
    experienceLevel,
    riskScore,
    riskProfile,
    recommendedBeginnerMode: experienceLevel === "intro" || experienceLevel === "novice",
  };
}

/** PUT 본문 검사. 틀리면 사람이 읽는 사유, 맞으면 null. */
export function answersError(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "answers가 필요합니다.";
  const a = raw as Record<string, unknown>;
  const unknown = Object.keys(a).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (unknown.length) return `모르는 문항입니다: ${unknown.join(", ")}`;
  for (const k of KEYS) if (!(k in a)) return `${k}에 답해 주세요.`;
  for (const k of ["q1", "q3", "q4", "q5", "q6", "q7"] as const) {
    const v = a[k];
    if (typeof v !== "string" || !(v in SCALE[k])) return `${k}의 답이 올바르지 않습니다.`;
  }
  const q2 = a.q2;
  if (!Array.isArray(q2) || q2.length === 0) return "q2는 하나 이상 골라 주세요.";
  if (q2.some((v) => !(PRODUCTS as readonly unknown[]).includes(v))) return "q2의 답이 올바르지 않습니다.";
  if (new Set(q2).size !== q2.length) return "q2에 같은 답이 두 번 있습니다.";
  if (q2.includes("deposit") && q2.length > 1) return "\"예적금만\"은 다른 보기와 같이 고를 수 없습니다.";
  return null;
}

/** 저장할 모양 (서버 accounts/assessment.clean_answers와 같다): 문항 순서 q1~q7, q2는 보기 순서(PRODUCTS)로. 먼저 answersError로 검사한다. */
export function cleanAnswers(a: InvestorAnswers): InvestorAnswers {
  return {
    q1: a.q1,
    q2: PRODUCTS.filter((p) => a.q2.includes(p)),
    q3: a.q3,
    q4: a.q4,
    q5: a.q5,
    q6: a.q6,
    q7: a.q7,
  };
}
