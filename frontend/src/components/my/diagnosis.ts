// 투자 성향·경험 진단 화면의 순수 계산 (점수는 서버가 낸다 — 여기는 답 모으기와 결과 문장만).
import type { InvestorAnswers, InvestorProduct, InvestorProfile } from "../../api/types";
import { EXPERIENCE_LEVEL_TEXT, INVESTOR_QUESTIONS, RISK_PROFILE_TEXT } from "../../lib/plainText";

/** 답하는 중인 진단: q2는 늘 배열, 나머지는 고르기 전이면 없다. */
export type DraftAnswers = Partial<Omit<InvestorAnswers, "q2">> & { q2: InvestorProduct[] };

/** q2(여럿 고름) 토글. "예적금만"(deposit)은 혼자만: 고르면 나머지를 지우고, 다른 보기를 고르면 deposit을 지운다. */
export function toggleProduct(current: readonly InvestorProduct[], value: InvestorProduct): InvestorProduct[] {
  if (current.includes(value)) return current.filter((v) => v !== value);
  if (value === "deposit") return ["deposit"];
  return [...current.filter((v) => v !== "deposit"), value];
}

/** 일곱 문항이 모두 답해졌으면 서버에 보낼 답, 아니면 null. */
export function completeAnswers(d: DraftAnswers): InvestorAnswers | null {
  const { q1, q3, q4, q5, q6, q7 } = d;
  if (!q1 || !q3 || !q4 || !q5 || !q6 || !q7 || d.q2.length === 0) return null;
  return { q1, q2: [...d.q2], q3, q4, q5, q6, q7 };
}

/** 문항마다 답했는지 (INVESTOR_QUESTIONS 순서). */
export function answeredFlags(d: DraftAnswers): boolean[] {
  return INVESTOR_QUESTIONS.map((q) => (q.key === "q2" ? d.q2.length > 0 : d[q.key] !== undefined));
}

/**
 * 건너뛴 문항의 순서(0부터): 이미 답한 문항 중 가장 뒤의 것보다 앞에 있는데 비어 있는 문항.
 * 차례대로 답하는 중이면 빈 배열이다 (아직 안 온 문항을 '빠졌다'고 하지 않게).
 */
export function skippedQuestions(d: DraftAnswers): number[] {
  const flags = answeredFlags(d);
  const last = flags.lastIndexOf(true);
  return flags.flatMap((done, i) => (!done && i < last ? [i] : []));
}

/** "진단 결과: 초급 · 위험중립형 → 주린이모드 켬 추천". 진단 전이면 null. */
export function resultLine(p: Pick<InvestorProfile, "experienceLevel" | "riskProfile" | "recommendedBeginnerMode">): string | null {
  if (!p.experienceLevel || !p.riskProfile || p.recommendedBeginnerMode === null) return null;
  return `진단 결과: ${EXPERIENCE_LEVEL_TEXT[p.experienceLevel]} · ${RISK_PROFILE_TEXT[p.riskProfile]} → 주린이모드 ${p.recommendedBeginnerMode ? "켬" : "끔"} 추천`;
}
