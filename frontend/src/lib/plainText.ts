// 쉬운 문장 표 (docs/컨셉변경계획.md 4-4·4-5, docs/API.md). 화면 문구만이고 코드·API 이름은 그대로다.
// 규칙: 주어를 밝히고(AI 의견·안전장치), 명령형·권유형을 쓰지 않고(docs/API.md "금지 표현"), 손실은 "더 클 수도 있어요"까지 말한다.
// 주문·체결·청산·자동매매를 말하는 쉬운 문장에는 "모의"를 넣는다 (실제 매매로 읽히지 않게).
// 모르는 코드는 서버가 준 원문을 그대로 보인다 (reasonSentence의 fallback).
import { ApiError, isBlocked } from "../api/client";
import type {
  CheckStatus,
  Currency,
  DayLockReason,
  ExitReason,
  ExperienceLevel,
  FundamentalsOverall,
  HoldingStyle,
  InvestorAnswers,
  NotificationKind,
  PlanEvent,
  ReasonCode,
  RecommendationSource,
  ReportFailureReason,
  ReportOpinion,
  ReportStatus,
  RiskProfile,
  ThesisAxis,
  TraceEvent,
  TradePlanStatus,
} from "../api/types";
import { formatKrw, formatPrice, formatQty, formatSignedKrw } from "./format";

/** 쉬운 보기(주린이모드 켬)와 전문가 보기(끔)의 이름. */
export interface Wording {
  easy: string;
  expert: string;
}

// ---------------------------------------------------------------- 고정 문구

export const SERVICE_NAME = "AI 리포트 데스크";

/** 통일 면책 문장 (리포트·PDF·화면). */
export const DISCLAIMER = "이 리포트는 AI가 만든 참고 자료이며 투자 권유가 아닙니다. 모든 매매는 모의 계좌에서만 이뤄집니다.";

/** 오늘의 내 종목 뉴스 카드·알림의 고정 문구. */
export const DAILY_MOVE_CAPTION = "등락의 원인을 단정하지 않습니다. 같은 날 나온 소식을 모은 것이며 투자 권유가 아닙니다.";
export const DAILY_MOVE_UNCERTAIN = "뚜렷한 소식을 찾지 못했어요";
export const DAILY_MOVE_KR_ONLY = "국내 종목만";
export const SECTOR_MISSING = "업종 자료 없음";

/** 펀더멘털 점검 고정 문구 (서버도 caption으로 같은 값을 낸다). */
export const FUNDAMENTALS_CAPTION = "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다";

/** 시장가 주문의 화면 추정 금액 안내. */
export const MARKET_ORDER_ESTIMATE = "직전 장마감 가격 기준 추정이에요. 시장가는 주문 시점 가격으로 체결돼요";

/** 장마감 기준 한 줄 설명 (가격 옆 "?" 등). */
export const CLOSE_BASIS_NOTE = "화면의 가격과 평가는 직전 정규장 종가예요. 모의 체결은 주문 시점 가격으로 해요";

/** 분석 상세의 가격은 장마감 기준이 아니다 (일부러 둔 예외). */
export const ANALYSIS_PRICE_LABEL = "분석 시각 가격";

/** 단타 연습 상시 문구. */
export const DAY_COST_NOTE = "단타는 비용이 손익을 크게 좌우해요";
export const DAY_LAG_NOTE = "분 단위 데이트레이딩 연습이에요. 목표·손절을 두 번 연속 확인해 팔아서 손절이 10초 넘게 늦을 수 있어요";
export const DAY_EOD_NOTE = "그날 15:15가 지나면 체결 대기 주문은 취소하고, 가진 주식은 바로 정리해요";
export const DAY_AI_REVIEW_PENDING = "AI 복기 — 준비 중";
export const MINUTE_PARTIAL = "일부 구간만 있어요";
export const MINUTE_UNAVAILABLE = "이 날짜의 분봉은 받을 수 없어요";

/** 투자 성향·경험 진단 안내. */
export const NOT_SUITABILITY = "법정 적합성 진단이 아니에요";

/** 리포트를 만드는 동안. */
export const REPORT_KEEPS_RUNNING = "이 화면을 닫아도 계속 만들어요. 만드는 동안 '리포트' 탭에 점이 보이고, 완성되면 위쪽 종으로 알려 드려요";
export const AI_REVIEW_NOTE = "AI 검토는 사실을 보증하지 않아요";

/** 화면 아래 공통 출처 줄 (docs/DECISIONS.md 14-1). quoteProvider는 MarketStatus.quoteProvider. */
export function sourceLine(quoteProvider: string): string {
  return `시세: ${quoteProvider} 조회 · 장마감 기준 | 공시·재무: 금융감독원 OpenDART, 금융위원회(공공데이터포털) | 뉴스 제목: Google 뉴스 검색 결과(각 언론사)`;
}

// ---------------------------------------------------------------- 리포트

export const REPORT_STATUS_TEXT: Record<ReportStatus, Wording> = {
  requested: { easy: "대기 중", expert: "신청됨" },
  running: { easy: "만드는 중", expert: "실행 중" },
  completed: { easy: "완성", expert: "완료" },
  failed: { easy: "만들지 못함", expert: "실패" },
};

export const reportStatusText = (status: string, easy = true): string => {
  const w = REPORT_STATUS_TEXT[status as ReportStatus];
  return w ? (easy ? w.easy : w.expert) : status;
};

export interface OpinionText {
  badge: string; // 배지 글자
  label: string; // "AI 의견: 긍정적"
  line: string; // 배지 아래 한 줄
  expert: string; // 전문가 보기
  tone: "positive" | "neutral" | "negative";
}

export const OPINION_TEXT: Record<ReportOpinion, OpinionText> = {
  buy: { badge: "긍정적", label: "AI 의견: 긍정적", line: "오를 근거가 더 많다고 봤어요", expert: "매수", tone: "positive" },
  hold: { badge: "지켜보기", label: "AI 의견: 지켜보기", line: "아직 판단하기 이르다고 봤어요", expert: "보유", tone: "neutral" },
  avoid: { badge: "부정적", label: "AI 의견: 부정적", line: "위험이 더 크다고 봤어요", expert: "회피", tone: "negative" },
};

export const opinionText = (opinion: string | null | undefined): OpinionText | null =>
  opinion ? (OPINION_TEXT[opinion as ReportOpinion] ?? null) : null;

/** 리포트 실패 사유 코드 (docs/tasks/00-공통.md 9절) → 쉬운 문장. */
export const REPORT_FAILURE_TEXT: Record<ReportFailureReason, string> = {
  join_blocked: "자료를 모으는 AI가 응답하지 않아 리포트를 쓸 수 없었어요",
  review_failed: "검토 AI가 근거와 맞지 않는 주장을 찾아 완성하지 않았어요",
  timeout: "시간이 너무 오래 걸려 멈췄어요",
  engine_restarted: "서버가 다시 시작돼 중단됐어요",
  exception: "예상하지 못한 오류로 멈췄어요",
};

export const REPORT_FAILURE_FALLBACK = "리포트를 만들지 못했어요. 다시 만들 수 있어요";

export function reportFailureSentence(reason: unknown): string {
  return typeof reason === "string" && reason in REPORT_FAILURE_TEXT
    ? REPORT_FAILURE_TEXT[reason as ReportFailureReason]
    : REPORT_FAILURE_FALLBACK;
}

/** Trace의 마지막 workflow_failed.details.reason (없으면 null). */
export function failureReasonOf(trace: TraceEvent[]): string | null {
  for (let i = trace.length - 1; i >= 0; i--) {
    const e = trace[i];
    if (e.action === "workflow_failed") return typeof e.details.reason === "string" ? e.details.reason : null;
  }
  return null;
}

// ---------------------------------------------------------------- 실행 불가 사유 (RiskPreview.reasonCodes, 400 {detail, reasonCodes})

export const REASON_TEXT: Record<ReasonCode, string> = {
  reward_risk_low: "버는 돈에 비해 잃을 수 있는 돈이 커서 안전장치가 막았어요(손익비 기준 2.0 미만)",
  ev_negative: "비용까지 따지면 기대되는 결과가 0 이하라 안전장치가 막았어요",
  daily_loss_limit: "오늘은 손실 한도에 닿아 새로 시작할 수 없어요. 내일 다시 할 수 있어요",
  daily_trades_limit: "오늘 할 수 있는 주문 수를 다 썼어요. 내일 다시 할 수 있어요",
  warning_stock: "투자경고 같은 매수 유의 종목이라 안전장치가 막았어요",
  size_too_small: "안전장치가 정한 수량이 1주도 안 돼요(계좌 크기에 비해 손절 폭이 커요)",
  budget_too_small: "예산으로는 1주도 살 수 없어요",
  expired: "이 계획은 기한이 끝났어요. 가격이 바뀌었을 수 있으니 새로 만들어 보세요",
  plan_exists: "이미 이 종목으로 진행 중인 계획이 있어요",
  position_exists: "이미 이 종목의 모의 주문이나 보유가 있어요(한 종목은 하나만 진행해요)",
  halted: "지금은 새 모의 매수를 멈춰 두었어요",
  price_passed: "가격이 이미 목표 가격을 넘었거나 손절 가격 아래로 내려왔어요",
  day_entry_closed: "지금은 단타 계획을 만들 수 없는 시간이에요(국내 거래일 15:15 전까지만 만들어요)",
  day_trading_locked: "단타 연습장이 잠겨 있어요. 주린이모드를 끄고 단타 연습 퀴즈를 통과하면 열려요",
  cash_short: "매수 가능 금액보다 사려는 금액이 커요",
  position_limit: "한 종목에 넣을 수 있는 비중 한도를 넘어요",
  total_limit: "총 투자 금액 한도를 넘어요",
};

export const isReasonCode = (code: string): code is ReasonCode => code in REASON_TEXT;

/** 사유 코드 → 쉬운 문장. 모르는 코드면 같은 자리의 원문(fallback), 그것도 없으면 코드 그대로. */
export function reasonSentence(code: string | null | undefined, fallback?: string | null): string {
  if (code && isReasonCode(code)) return REASON_TEXT[code];
  return fallback || code || "";
}

/** reasonCodes와 원문 reasons(같은 길이·순서)를 쉬운 문장 목록으로 (같은 문장은 한 번만). 코드가 모자라면 원문을 그대로. */
export function reasonSentences(codes: readonly string[] | null | undefined, raws: readonly string[] = []): string[] {
  const out: string[] = [];
  const n = Math.max(codes?.length ?? 0, raws.length);
  for (let i = 0; i < n; i++) {
    const s = reasonSentence(codes?.[i], raws[i]);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 400 {detail, reasonCodes} 오류 → 쉬운 사유 문장 목록. 사유 코드가 없는 오류(입력 오류 등)는 null —
 * 그때는 ApiError.detail을 그대로 보인다.
 */
export function rejectionSentences(err: unknown): string[] | null {
  if (!isBlocked(err)) return null;
  return reasonSentences(err.reasonCodes, err.detail.split("; "));
}

/** 오류를 화면 한 줄로: 실행 불가 사유면 쉬운 문장을 이어서, 아니면 서버 detail. */
export function errorSentence(err: unknown): string {
  const reasons = rejectionSentences(err);
  if (reasons?.length) return reasons.join(" · ");
  if (err instanceof ApiError) return err.detail;
  if (err instanceof Error && err.message) return err.message;
  return "요청에 실패했어요.";
}

// ---------------------------------------------------------------- 매매 계획 · 자동매매

export interface PlanStatusText extends Wording {
  line: string; // 쉬운 보기 설명 한 줄
}

export const PLAN_STATUS_TEXT: Record<TradePlanStatus, PlanStatusText> = {
  active: { easy: "시작했어요", line: "모의 자동매매를 시작했어요. 곧 사는 주문을 넣어요", expert: "활성화됨" },
  entry_pending: { easy: "사는 가격을 기다리는 중", line: "사는 가격 이하가 되면 모의 계좌에서 사요", expert: "체결 대기" },
  holding: {
    easy: "목표·손절을 지켜보는 중",
    line: "목표 가격에 닿으면 모의 계좌에서 팔고, 손절 가격 아래로 내려가면 손실이 더 커지지 않게 팔아요",
    expert: "보유 중",
  },
  closed: { easy: "팔았어요", line: "모의 자동매매가 끝났어요", expert: "청산 완료" },
  cancelled: { easy: "내가 멈췄어요", line: "내가 모의 자동매매를 멈췄어요", expert: "중단됨" },
  expired: { easy: "사지 않고 끝났어요", line: "사는 가격까지 내려오지 않아 모의 계좌에서 사지 않고 끝났어요(돈은 그대로)", expert: "기한 만료" },
  failed: { easy: "이어가지 못했어요", line: "시스템 문제로 모의 자동매매를 이어가지 못했어요", expert: "실패" },
};

export const planStatusText = (status: string, easy = true): string => {
  const w = PLAN_STATUS_TEXT[status as TradePlanStatus];
  return w ? (easy ? w.easy : w.expert) : status;
};

/** 청산 사유. expert는 docs/API.md "청산 사유" 표의 화면 이름. 쉬운 문장에는 "모의"를 넣는다 (체결 내역·계획 화면에서 실제 매도로 읽히지 않게). */
export const EXIT_REASON_TEXT: Record<ExitReason, Wording> = {
  TARGET: { easy: "목표 가격에 닿아 모의 계좌에서 팔았어요", expert: "목표가 도달" },
  STOP: { easy: "손절 가격에 닿아 손실이 더 커지지 않게 모의 계좌에서 팔았어요", expert: "손절가 도달" },
  EXPIRED: { easy: "보유 기간이 끝나 그날 가격에 모의 계좌에서 팔았어요", expert: "보유 기한 경과" },
  MANUAL: { easy: "직접 모의 계좌에서 팔았어요", expert: "사용자 매도" },
  EOD: { easy: "단타라 장 마감 전에 모의 계좌에서 정리했어요", expert: "장 마감 전 정리" },
};

export const exitReasonText = (reason: string | null | undefined, easy = true): string => {
  if (!reason) return "";
  const w = EXIT_REASON_TEXT[reason as ExitReason];
  return w ? (easy ? w.easy : w.expert) : reason;
};

// "모의 계좌에서 …에 팔았어요" 앞에 붙는 청산 사유
const CLOSED_PREFIX: Record<ExitReason, string> = {
  TARGET: "목표 가격에 닿아",
  STOP: "손절 가격에 닿아 손실이 더 커지지 않게",
  EXPIRED: "보유 기간이 끝나",
  MANUAL: "직접",
  EOD: "단타라 장 마감 전에",
};

const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 계획 사건 → 쉬운 문장 (쉬운 보기). 화면이 kind + details로 만들고, 서버의 원래 message는 전문가 보기에 쓴다.
 * 모르는 kind나 details가 모자라면 message를 그대로.
 */
export function planEventSentence(e: Pick<PlanEvent, "kind" | "details" | "message">, currency: Currency = "KRW"): string {
  const d = e.details ?? {};
  const qty = numOf(d.quantity);
  const price = (v: unknown) => formatPrice(numOf(v), currency);
  switch (e.kind) {
    case "activated": {
      const budget = numOf(d.budgetKrw);
      return `모의 자동매매를 시작했어요${budget ? ` (예산 ${formatKrw(budget)})` : ""}`;
    }
    case "risk_checked":
      if (d.approved === false) return "안전장치가 모의 주문을 막았어요";
      return qty !== null ? `안전장치가 모의 주문 수량을 ${formatQty(qty)}로 정했어요` : "안전장치가 모의 주문 수량을 정했어요";
    case "order_placed":
      if (qty === null || numOf(d.limitPrice) === null) break;
      return `모의 계좌에서 ${price(d.limitPrice)} 이하에 ${formatQty(qty)}를 사는 주문을 넣었어요`;
    case "order_requeued": {
      const prev = numOf(d.previousQuantity);
      const fewer = prev !== null && qty !== null && qty < prev ? ` (수량 ${formatQty(prev)} → ${formatQty(qty)})` : "";
      return `그날 사지 못해 다음 장에 모의 주문을 다시 넣었어요${fewer}`;
    }
    case "filled":
      if (qty === null || numOf(d.fillPrice) === null) break;
      return `모의 계좌에서 ${price(d.fillPrice)}에 ${formatQty(qty)}를 샀어요`;
    case "exit_requested":
      return "가진 수량을 모두 팔도록 요청했어요. 장이 닫혀 있으면 다음 장 시작에 모의 계좌에서 팔아요";
    case "closed": {
      const reason = typeof d.exitReason === "string" ? d.exitReason : null;
      const prefix = reason && reason in CLOSED_PREFIX ? `${CLOSED_PREFIX[reason as ExitReason]} ` : "";
      const pnl = numOf(d.pnlKrw);
      if (numOf(d.exitPrice) === null) break;
      return `${prefix}모의 계좌에서 ${price(d.exitPrice)}에 팔았어요${pnl !== null ? ` (손익 ${formatSignedKrw(pnl)})` : ""}`;
    }
    case "cancelled":
      return "내가 모의 자동매매를 멈췄어요";
    case "expired":
      return "사는 가격까지 내려오지 않아 모의 계좌에서 사지 않고 끝났어요(돈은 그대로)";
    case "failed":
      return "시스템 문제로 모의 자동매매를 이어가지 못했어요";
  }
  return e.message;
}

// ---------------------------------------------------------------- 출처 · 보유 방식 · 알림

export const SOURCE_TEXT: Record<RecommendationSource, { label: string; hint: string }> = {
  report: { label: "AI 리포트", hint: "AI 리포트의 결론에서 나온 계획" },
  analysis: { label: "AI 교차검증 분석", hint: "여러 AI가 서로 검증한 분석에서 나온 계획 (리포트 없음)" },
  demo: { label: "연습용 예시 계획 (AI 아님)", hint: "최근 변동폭으로 정한 규칙 기반 예시" },
  day: { label: "단타 연습 계획 (직접 입력, AI 아님)", hint: "단타 연습장에서 내가 정한 가격" },
};

export const HOLDING_STYLE_TEXT: Record<HoldingStyle, { label: string; hint: string }> = {
  swing: { label: "스윙", hint: "목표·손절(정했으면 보유 기한)에 닿으면 자동으로 팔아요" },
  long: { label: "장기 보유", hint: "자동으로 팔지 않아요. 내가 팔 때까지 보유해요" },
  day: { label: "단타", hint: "그날 15:15가 지나면 정리해요" },
};

export const NOTIFICATION_KIND_TEXT: Record<NotificationKind, string> = {
  recommendation: "새 계획 제안",
  plan_activated: "모의 자동매매 시작",
  order_placed: "모의 주문 접수",
  order_requeued: "모의 주문 다시 넣음",
  filled: "모의 체결",
  closed: "모의 매도 완료",
  cancelled: "자동매매 멈춤",
  expired: "사지 않고 끝남",
  failed: "자동매매 실패",
  system: "알림",
  report_completed: "리포트 완성",
  report_failed: "리포트 만들지 못함",
  daily_move: "오늘의 내 종목 뉴스",
  thesis_check: "펀더멘털 점검",
};

export const notificationKindText = (kind: string): string => NOTIFICATION_KIND_TEXT[kind as NotificationKind] ?? "알림";

// ---------------------------------------------------------------- 장기투자

/** 종합 판정 (중립 표기 — "견조"·"점검 필요"는 쓰지 않는다). */
export const FUNDAMENTALS_OVERALL_TEXT: Record<FundamentalsOverall, string> = {
  solid: "기준 충족",
  caution: "주의",
  review: "확인 필요",
  na: "적용하지 않음",
};

export const CHECK_STATUS_TEXT: Record<CheckStatus, { mark: string; label: string }> = {
  ok: { mark: "✓", label: "기준 충족" },
  warn: { mark: "△", label: "주의" },
  bad: { mark: "✗", label: "확인 필요" },
  na: { mark: "–", label: "판정 없음" },
};

export const THESIS_AXIS_TEXT: Record<ThesisAxis, string> = {
  growth: "성장",
  profitability: "수익성",
  balance_sheet: "재무 안정",
};

// ---------------------------------------------------------------- 단타 잠금 · 투자자 프로필

export const DAY_LOCK_TEXT: Record<DayLockReason, string> = {
  beginner_mode: "주린이모드가 켜져 있어요. 마이에서 끌 수 있어요",
  quiz_not_passed: "단타 연습 퀴즈 5문항을 모두 맞혀야 열려요",
};

export const EXPERIENCE_LEVEL_TEXT: Record<ExperienceLevel, string> = {
  intro: "입문",
  novice: "초급",
  intermediate: "중급",
  expert: "숙련",
};

export const RISK_PROFILE_TEXT: Record<RiskProfile, string> = {
  stable: "안정형",
  stable_seeking: "안정추구형",
  neutral: "위험중립형",
  active: "적극투자형",
  aggressive: "공격투자형",
};

export interface InvestorQuestion<K extends keyof InvestorAnswers = keyof InvestorAnswers> {
  key: K;
  text: string;
  multiple: boolean; // q2만 여럿 고름 (deposit은 혼자만)
  choices: { value: string; label: string }[];
}

/** 투자 성향·경험 진단 7문항 (docs/API.md "투자자 프로필과 주린이모드" 표 그대로. 점수는 서버가 계산한다). */
export const INVESTOR_QUESTIONS: InvestorQuestion[] = [
  {
    key: "q1",
    text: "주식 투자를 해 본 기간",
    multiple: false,
    choices: [
      { value: "none", label: "없음" },
      { value: "under_1y", label: "1년 미만" },
      { value: "1_3y", label: "1~3년" },
      { value: "over_3y", label: "3년 이상" },
    ],
  },
  {
    key: "q2",
    text: "거래해 본 상품 (여럿 고를 수 있어요)",
    multiple: true,
    choices: [
      { value: "deposit", label: "예적금만" },
      { value: "fund_etf", label: "펀드·ETF" },
      { value: "kr_stock", label: "국내 주식" },
      { value: "us_stock", label: "해외 주식" },
      { value: "derivatives", label: "레버리지 ETF·선물·옵션" },
    ],
  },
  {
    key: "q3",
    text: "주식 거래 빈도",
    multiple: false,
    choices: [
      { value: "never", label: "해 본 적 없음" },
      { value: "yearly", label: "1년에 몇 번" },
      { value: "monthly", label: "한 달에 몇 번" },
      { value: "daily", label: "거의 매일" },
    ],
  },
  {
    key: "q4",
    text: "\"PER, 손절, 지정가\"를 남에게 설명할 수 있나요",
    multiple: false,
    choices: [
      { value: "unknown", label: "모름" },
      { value: "heard", label: "들어 봄" },
      { value: "explain", label: "설명할 수 있음" },
    ],
  },
  {
    key: "q5",
    text: "1,000만 원을 넣었다면 견딜 수 있는 손실",
    multiple: false,
    choices: [
      { value: "no_loss", label: "원금 손실은 싫다" },
      { value: "loss_10", label: "−10%까지" },
      { value: "loss_20", label: "−20%까지" },
      { value: "more", label: "그 이상도 괜찮다" },
    ],
  },
  {
    key: "q6",
    text: "주로 생각하는 투자 기간",
    multiple: false,
    choices: [
      { value: "years", label: "몇 년 이상" },
      { value: "weeks", label: "몇 주" },
      { value: "intraday", label: "하루 안" },
    ],
  },
  {
    key: "q7",
    text: "투자 목적",
    multiple: false,
    choices: [
      { value: "practice", label: "연습·공부" },
      { value: "growth", label: "꾸준한 자산 증식" },
      { value: "short_term", label: "짧은 기간 수익" },
    ],
  },
];
