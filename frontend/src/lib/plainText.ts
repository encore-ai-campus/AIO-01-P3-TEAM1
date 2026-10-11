// 쉬운 문장 표 (docs/plans/컨셉변경계획.md 4-4·4-5, docs/API.md). 화면 문구만이고 코드·API 이름은 그대로다.
// 규칙: 주어를 밝히고(AI 의견·안전장치), 명령형·권유형을 쓰지 않고(docs/API.md "금지 표현"), 손실은 "더 클 수도 있어요"까지 말한다.
// 주문·체결·청산·자동매매를 말하는 쉬운 문장에는 "모의"를 넣는다 (실제 매매로 읽히지 않게).
// 모르는 코드는 서버가 준 원문을 그대로 보인다 (reasonSentence의 fallback).
import { ApiError, isBlocked } from "../api/client";
import type {
  CheckStatus,
  Currency,
  ExitReason,
  ExperienceLevel,
  FundamentalsOverall,
  HoldingStyle,
  InvestorAnswers,
  NotificationKind,
  PlanEvent,
  QuoteBasis,
  ReasonCode,
  RecommendationExpiredReason,
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

/**
 * 서비스 이름 (docs/DECISIONS.md 18장 — 2026-10-07에 바뀜. 전 이름은 '종이배'(15-7), 그 전은 D-5). 붙여 쓰고 꾸밈말을 붙이지 않는다('AI 모매매' 아님).
 * 부제는 이 서비스의 핵심(여러 AI의 교차검증 + 모의투자)을 한 줄로 말한다. 풀이 한 줄은 그것을 풀어 쓰고, 아래 안심 줄('실제 주문은 나가지 않아요')과 같은 말을 되풀이하지 않는다.
 * 문구에 쓰지 않는 말: 배 은어(탑승·승선·선장·출항·순항), 띄우다·접다, 침몰·가라앉다·구조, '배(倍)' 말장난 — 옛 종이배 로고 때 정한 규칙이지만 문구가 깔끔해 그대로 지킨다.
 * 로고는 components/brand/BrandMark.tsx. 백엔드에도 같은 이름이 둘 있다 (notifications/service.py HEADER, reports/output/pdf.py SERVICE_NAME).
 */
export const SERVICE_NAME = "모매매";

/** 부제: 이름 바로 아래 (로그인 첫 화면·발표 첫 장). */
export const SERVICE_TAGLINE = "여러 AI가 함께 검증하는 모의투자";

/** 첫 화면(로그인)의 풀이 한 줄: 부제의 '여러 AI가 함께 검증'을 풀어 말한다. */
export const SERVICE_INTRO = "AI들이 조사하고 서로 따져 본 리포트를 읽고, 가상 현금으로 매매를 연습해요.";

/** 통일 면책 문장 (리포트·PDF·화면). */
export const DISCLAIMER = "이 리포트는 AI가 만든 참고 자료이며 투자 권유가 아닙니다. 모든 매매는 모의 계좌에서만 이뤄집니다.";

/** 오늘의 내 종목 뉴스 카드·알림의 고정 문구. */
export const DAILY_MOVE_CAPTION = "등락의 원인을 단정하지 않습니다. 같은 날 나온 소식을 모은 것이며 투자 권유가 아닙니다.";
export const DAILY_MOVE_UNCERTAIN = "뚜렷한 소식을 찾지 못했어요";
export const DAILY_MOVE_KR_ONLY = "국내 종목만";
export const SECTOR_MISSING = "업종 자료 없음";

/** 펀더멘털 점검 고정 문구 (서버도 caption으로 같은 값을 낸다). */
export const FUNDAMENTALS_CAPTION = "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다";

/** 시장가 주문의 화면 추정 금액 안내. 시세를 받지 못해 직전 종가로 보일 때의 문장. */
export const MARKET_ORDER_ESTIMATE = "직전 장마감 가격 기준 추정이에요. 시장가는 주문 시점 가격으로 체결돼요";
/** 시장가 주문의 화면 추정 금액 안내 — 실시간 시세로 보일 때 (docs/API.md 공통 규칙 "실시간 시세"). */
export const MARKET_ORDER_ESTIMATE_LIVE = "지금 시세 기준 추정이에요. 시장가는 주문 시점 가격으로 체결돼요";
export const marketOrderEstimate = (basis: QuoteBasis | undefined): string => (basis === "live" ? MARKET_ORDER_ESTIMATE_LIVE : MARKET_ORDER_ESTIMATE);

/**
 * 시세 가격의 이름 (Quote.basis): 실시간이면 현재가(쉬운 보기는 "지금 가격"), 장마감 기준이면 종가.
 * 계좌 평가·미리 보기·랭킹처럼 장마감 기준인 곳은 이 함수를 쓰지 않고 "종가"를 그대로 적는다.
 */
export function quotePriceName(basis: QuoteBasis | undefined, easy = false): string {
  return basis === "live" ? (easy ? "지금 가격" : "현재가") : "종가";
}

/** 장마감 기준 한 줄 설명 (가격 옆 "?" 등). 계좌 평가·랭킹·미리 보기 같은 장마감 기준 화면의 설명이다 (종목 시세는 실시간). */
export const CLOSE_BASIS_NOTE = "계좌 평가와 랭킹은 직전 정규장 종가예요. 모의 체결은 주문 시점 가격으로 해요";

/** 분석 상세의 가격은 장마감 기준이 아니다 (일부러 둔 예외). */
export const ANALYSIS_PRICE_LABEL = "분석 시각 가격";

/** 투자 성향·경험 진단 안내. */
export const NOT_SUITABILITY = "증권사의 공식 투자 성향 검사가 아니에요";

/**
 * 리포트를 만드는 동안. 기기와 상관없는 말로 쓴다: 표시는 모바일 하단 탭의 점·PC 왼쪽 메뉴의 '만드는 중' 칩이고,
 * 알림 종은 모바일은 화면 머리·PC는 왼쪽 메뉴에 있다 (Layout).
 */
export const REPORT_KEEPS_RUNNING = "이 화면을 닫아도 계속 만들어요. 만드는 동안 '리포트' 메뉴에 표시가 붙고, 완성되면 알림으로 알려 드려요";
// 쉬운 PDF(backend/reports/output/easy_text.py)도 같은 문장을 쓴다 — 바꾸면 둘 다 고친다
export const AI_REVIEW_NOTE = "AI 검토는 사실을 보증하지 않아요";

/** 화면 아래 공통 출처 줄 (docs/DECISIONS.md 14-1·17장). quoteProvider는 MarketStatus.quoteProvider. */
export function sourceLine(quoteProvider: string): string {
  return `시세: ${quoteProvider} 조회 · 실시간 (계좌·랭킹은 장마감 기준) | 공시·재무: 금융감독원 OpenDART, 금융위원회(공공데이터포털) | 뉴스 제목: Google 뉴스 검색 결과(각 언론사)`;
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

// 쉬운 PDF(backend/reports/output/easy_text.py OPINION_LINE, 배지는 text.py OPINION_LABEL)도 같은 문장을 쓴다 — 바꾸면 둘 다 고친다
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
  agent_failed: "필요한 AI가 끝내 응답하지 않아 멈췄어요",
  no_llm: "AI 연결 설정이 없어 리포트를 쓰지 못했어요",
  expired: "오래 기다린 신청이라 실행하지 않았어요",
};

export const REPORT_FAILURE_FALLBACK = "리포트를 만들지 못했어요. 다시 만들 수 있어요";

export function reportFailureSentence(reason: unknown): string {
  return typeof reason === "string" && reason in REPORT_FAILURE_TEXT
    ? REPORT_FAILURE_TEXT[reason as ReportFailureReason]
    : REPORT_FAILURE_FALLBACK;
}

/**
 * 오늘의 선별을 규칙으로 고른 사유 (ScreeningResult.fallbackReason → 쉬운 문장). 코드는 리포트 실패 사유 + no_candidates.
 * 리포트 문장 중 "리포트를 쓸 수 없었어요"처럼 리포트를 말하는 것만 선정에 맞게 바꾸고, 나머지는 같은 문장이다.
 */
export const SELECTION_FALLBACK_TEXT: Record<ReportFailureReason | "no_candidates", string> = {
  ...REPORT_FAILURE_TEXT,
  join_blocked: "후보를 조사하는 AI가 응답하지 않아 AI가 고르지 못했어요",
  review_failed: "검토 AI가 근거와 맞지 않는 선정을 찾아 AI 선정안을 쓰지 않았어요",
  no_llm: "AI 연결 설정이 없어 AI가 고르지 못했어요",
  expired: "선정 실행이 오래 기다리다 실행되지 않아 AI가 고르지 못했어요",
  no_candidates: "규칙 선별을 통과한 종목이 없었어요",
};

export const SELECTION_FALLBACK_FALLBACK = "AI 선정을 끝내지 못했어요";

export function selectionFallbackSentence(reason: unknown): string {
  return typeof reason === "string" && reason in SELECTION_FALLBACK_TEXT
    ? SELECTION_FALLBACK_TEXT[reason as keyof typeof SELECTION_FALLBACK_TEXT]
    : SELECTION_FALLBACK_FALLBACK;
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
  reward_risk_low: "버는 돈에 비해 잃을 수 있는 돈이 커서 안전장치가 막았어요(손익비 기준 1.5 미만)",
  ev_negative: "비용까지 따지면 기대되는 결과가 0 이하라 안전장치가 막았어요",
  daily_loss_limit: "오늘은 손실 한도에 닿아 새로 시작할 수 없어요. 내일 다시 할 수 있어요",
  daily_trades_limit: "오늘 할 수 있는 주문 수를 다 썼어요. 내일 다시 할 수 있어요",
  warning_stock: "투자경고 같은 매수 유의 종목이라 안전장치가 막았어요",
  size_too_small: "안전장치가 정한 수량이 1주도 안 돼요(계좌 크기에 비해 손절 폭이 커요)",
  budget_too_small: "이 금액으로는 1주도 살 수 없어요",
  expired: "이 계획은 기한이 끝났어요. 가격이 바뀌었을 수 있으니 새로 만들어 보세요",
  plan_exists: "이미 이 종목으로 진행 중인 계획이 있어요",
  position_exists: "이미 이 종목의 모의 주문이나 보유가 있어요(한 종목은 하나만 진행해요)",
  halted: "지금은 새 모의 매수를 멈춰 두었어요",
  price_passed: "가격이 이미 목표 가격을 넘었거나 손절 가격 아래로 내려왔어요",
  cash_short: "매수 가능 금액보다 사려는 금액이 커요",
  position_limit: "한 종목에 넣을 수 있는 비중 한도를 넘어요",
  total_limit: "총 투자 금액 한도를 넘어요",
};

export const isReasonCode = (code: string): code is ReasonCode => code in REASON_TEXT;

/**
 * 사유 문장을 고르는 문맥: order = 장기 매수 주문(POST /api/orders long — assess_position), plan = 계획 미리 보기·활성화(assess_budget).
 * 같은 코드(cash_short·total_limit)를 두 곳이 쓰지만 계획에서는 '내가 정한 금액(넣을 돈)'을 말한다 (2026-10-11 DECISIONS 28장).
 */
export type ReasonContext = "order" | "plan";

/** 계획 문맥에서만 다른 문장 (없는 코드는 REASON_TEXT 그대로). */
export const PLAN_REASON_TEXT: Partial<Record<ReasonCode, string>> = {
  cash_short: "넣을 돈이 매수 가능 금액보다 많아요",
  total_limit: "모의 자동매매에 넣을 수 있는 총 금액 한도를 넘어요",
};

/**
 * 목록 카드의 '지금은 시작할 수 없음 · …' 뒤에 붙는 한 마디 (Recommendation.blockedBy — 계좌와 무관한 사유만, DECISIONS 23장).
 * 쉬운 말은 REASON_TEXT의 앞부분('안전장치가 막았어요' 앞)과 같은 뜻이다. 모르는 코드는 REASON_TEXT 문장 그대로.
 */
export const BLOCKED_SHORT_TEXT: Partial<Record<ReasonCode, Wording>> = {
  reward_risk_low: { easy: "버는 돈에 비해 잃을 수 있는 돈이 커요", expert: "손익비 1.5 미만" },
  ev_negative: { easy: "비용까지 따지면 기대되는 결과가 0 이하예요", expert: "기대수익률 0 이하" },
  expired: { easy: "기한이 끝났어요", expert: "만료" },
};

/**
 * 가격이 이미 손절가·목표가를 지나 끝난 계획 제안의 문장 (Recommendation.expiredReason, 2026-10-08 DECISIONS 25장).
 * long: 쉬운 보기의 문장 · short: 칩처럼 짧은 곳 · expert: 전문가 보기. 장중 가격 숫자는 넣지 않는다 (docs/API.md 공통 규칙).
 * 기한이 지나 끝난 것(deadline)·까닭을 모르는 것(null)은 없다 — 그때는 화면이 지금 문구('기한 지남'·'만료')를 그대로 쓴다.
 */
export const PRICE_EXPIRED_TEXT: Record<Exclude<RecommendationExpiredReason, "deadline">, { long: string; short: string; expert: string }> = {
  below_stop: { long: "가격이 이미 손절 가격 아래로 내려가 끝난 제안이에요", short: "손절 가격 아래로 내려감", expert: "손절가 이탈로 만료" },
  above_target: { long: "가격이 이미 목표 가격을 넘어 끝난 제안이에요", short: "목표 가격을 넘음", expert: "목표가 도달로 만료" },
};

/**
 * 가격 때문에 끝난 제안의 문장 (쉬운 보기는 길이 kind, 전문가 보기는 늘 expert 문장). 기한·모름이면 null.
 * expiredReason이 없는 옛 응답도 null이다.
 */
export function priceExpiredText(
  reason: RecommendationExpiredReason | null | undefined,
  easy: boolean,
  kind: "long" | "short" = "long",
): string | null {
  if (reason !== "below_stop" && reason !== "above_target") return null;
  const t = PRICE_EXPIRED_TEXT[reason];
  return easy ? t[kind] : t.expert;
}

/** blockedBy 사유 코드 → 한 마디 (첫 사유 하나, 없으면 빈 문자열). */
export function blockedShort(codes: readonly string[] | null | undefined, easy = true): string {
  const code = codes?.[0];
  if (!code) return "";
  const w = BLOCKED_SHORT_TEXT[code as ReasonCode];
  return w ? (easy ? w.easy : w.expert) : reasonSentence(code);
}

/** 사유 코드 → 쉬운 문장. 모르는 코드면 같은 자리의 원문(fallback), 그것도 없으면 코드 그대로. context가 plan이면 계획 문장(PLAN_REASON_TEXT)을 먼저. */
export function reasonSentence(code: string | null | undefined, fallback?: string | null, context: ReasonContext = "order"): string {
  if (code && isReasonCode(code)) return (context === "plan" ? PLAN_REASON_TEXT[code] : undefined) ?? REASON_TEXT[code];
  return fallback || code || "";
}

/** reasonCodes와 원문 reasons(같은 길이·순서)를 쉬운 문장 목록으로 (같은 문장은 한 번만). 코드가 모자라면 원문을 그대로. */
export function reasonSentences(codes: readonly string[] | null | undefined, raws: readonly string[] = [], context: ReasonContext = "order"): string[] {
  const out: string[] = [];
  const n = Math.max(codes?.length ?? 0, raws.length);
  for (let i = 0; i < n; i++) {
    const s = reasonSentence(codes?.[i], raws[i], context);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 400 {detail, reasonCodes} 오류 → 쉬운 사유 문장 목록. 사유 코드가 없는 오류(입력 오류 등)는 null —
 * 그때는 ApiError.detail을 그대로 보인다.
 */
export function rejectionSentences(err: unknown, context: ReasonContext = "order"): string[] | null {
  if (!isBlocked(err)) return null;
  return reasonSentences(err.reasonCodes, err.detail.split("; "), context);
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

/**
 * 시연용 수동 시작 (2026-10-12 사용자 결정, DECISIONS 31장 — docs/API.md manualStart): 안전장치(리스크 엔진)가 손익비·기대값만으로 막은 계획을
 * 시연을 위해 직접 시작한다. 이 기능이 나오는 모든 자리에 '시연용'을 쓴다. 청산 사유 MANUAL(사용자 매도)·연습용 예시(source demo)와 다른 것이다.
 */
export const MANUAL_START_TEXT = {
  badge: "시연용 수동 시작",
  button: "수동매매 (시연용)",
  cardNote: {
    easy: "시연용 기능이에요. 안전장치가 손익비·기대 수익 점검으로 막은 계획을 직접 시작해 볼 수 있어요. 넣을 돈과 다른 안전장치(매수 가능 금액·한도·가격)는 그대로 확인해요.",
    expert: "시연용: 리스크 엔진의 손익비·기대값 점검만 건너뛰고 수동으로 활성화합니다. 투자 금액·한도·가격 점검은 그대로입니다.",
  },
  linkHint: { easy: "시연용 기능: 손익비·기대 수익 점검만 건너뛰고 직접 시작해요", expert: "시연용: 손익비·기대값 점검만 건너뜁니다" },
  topNote: {
    easy: "아래 실행 확인에서 넣을 돈을 정하고 확인하면 시연을 위해 직접 시작해요.",
    expert: "아래 활성화 카드에서 투자 금액을 정하고 확인하면 시연을 위해 수동으로 활성화합니다.",
  },
  /** Discord 활성화 링크(?t=)의 띠 문장 — 그때는 위 topNote 띠를 따로 두지 않으므로 여기서 '시연용'과 실제 시작 버튼 이름(start)을 말한다 */
  discordNote: {
    easy: "시연용 수동 시작이에요. 내용을 확인하고 “모의 수동매매 시작 (시연용)” 버튼을 누르면 시연을 위해 내 모의 계좌에서 직접 시작해요 (Discord로 시작한 것으로 기록해요).",
    expert: "시연용 수동 시작입니다. 내용을 확인하고 “수동매매 활성화 (시연용)” 버튼을 누르면 시연을 위해 내 모의 계좌에 계획이 수동으로 만들어집니다 (Discord로 활성화한 것으로 기록).",
  },
  banner: {
    easy: "시연용 수동 시작이에요. 아래 이유로 안전장치가 막은 계획을 시연을 위해 직접 시작해요. 실제 투자 판단의 근거가 아니에요.",
    expert: "시연용 수동 시작 — 리스크 엔진이 아래 사유로 거절한 계획을 시연을 위해 수동으로 활성화합니다. 그 밖의 점검은 그대로입니다.",
  },
  check: "안전장치의 손익비·기대 수익 점검을 통과하지 못한 계획을 시연용으로 직접 시작해요.",
  checksHint: "위의 확인 넷을 모두 켜면 시작할 수 있어요.",
  expertCheck: "시연용 수동 시작 (손익비·기대값 점검 건너뜀)",
  previewSkipped: "리스크 엔진 기준 미달 — 시연용 수동 시작으로 건너뜀",
  start: { easy: "모의 수동매매 시작 (시연용)", expert: "수동매매 활성화 (시연용)" }, // 쉬운 보기 시작 버튼에는 "모의"를 넣는다 (이 파일 머리 규칙)
  planNote: {
    easy: "시연용으로 직접 시작한 모의 자동매매예요. 안전장치의 손익비·기대 수익 점검을 건너뛰었어요.",
    expert: "시연용 수동 시작: 리스크 엔진의 손익비·기대값 점검을 건너뛰고 활성화한 계획입니다.",
  },
  toast: "시연용 수동 시작 · ",
} as const;

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
};

export const exitReasonText = (reason: string | null | undefined, easy = true): string => {
  if (!reason) return "";
  const w = EXIT_REASON_TEXT[reason as ExitReason];
  return w ? (easy ? w.easy : w.expert) : reason;
};

/** 모의 자동매매(계획) 화면의 쉬운 청산 문장: 사용자 매도(MANUAL)는 '멈추기'로 판 것이다. 체결 내역의 직접 매도는 exitReasonText 그대로. */
export const PLAN_MANUAL_EXIT = "멈추기로 모의 계좌에서 팔았어요";

export const planExitText = (reason: string | null | undefined, easy = true): string =>
  easy && reason === "MANUAL" ? PLAN_MANUAL_EXIT : exitReasonText(reason, easy);

// "모의 계좌에서 …에 팔았어요" 앞에 붙는 청산 사유 (계획 사건 — 사용자 매도는 계획을 멈춘 것)
const CLOSED_PREFIX: Record<ExitReason, string> = {
  TARGET: "목표 가격에 닿아",
  STOP: "손절 가격에 닿아 손실이 더 커지지 않게",
  EXPIRED: "보유 기간이 끝나",
  MANUAL: "멈추기로",
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
      // 2026-10-11부터 넣을 돈(budgetMode·budgetPercent·budgetKrw)을 남긴다. 그 전 계획은 선택 예산(budgetKrw)만
      const budget = numOf(d.budgetKrw);
      const percent = numOf(d.budgetPercent);
      const put =
        d.budgetMode === "percent" && percent !== null
          ? ` (넣은 돈: 내 자금의 ${percent}%${budget !== null ? ` · ${formatKrw(budget)}` : ""})`
          : d.budgetMode === "amount" && budget !== null
            ? ` (넣은 돈: ${formatKrw(budget)})`
            : budget
              ? ` (예산 ${formatKrw(budget)})`
              : "";
      return d.manualStart === true ? `시연용으로 모의 자동매매를 직접 시작했어요${put}` : `모의 자동매매를 시작했어요${put}`;
    }
    case "risk_checked":
      // 시연용 수동 시작(DECISIONS 31장)은 approved=false(리스크 엔진의 원래 판정)를 남기지만 막힌 것이 아니다 — approved보다 먼저 본다
      if (d.manualStart === true) {
        return qty !== null
          ? `시연용 수동 시작이라 안전장치의 손익비·기대 수익 점검을 건너뛰고, 넣은 돈으로 모의 주문 수량 ${formatQty(qty)}를 계산했어요`
          : "시연용 수동 시작이라 안전장치의 손익비·기대 수익 점검을 건너뛰었어요";
      }
      if (d.approved === false) return "안전장치가 모의 주문을 막았어요";
      // 2026-10-11부터 수량은 내가 정한 금액으로 계산하고 안전장치는 한도를 점검만 한다 (limitedBy "내가 정한 금액")
      if (d.limitedBy === "내가 정한 금액" && qty !== null) return `넣은 돈으로 모의 주문 수량 ${formatQty(qty)}를 계산했고, 안전장치가 한도를 확인했어요`;
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
};

export const HOLDING_STYLE_TEXT: Record<HoldingStyle, { label: string; hint: string }> = {
  swing: { label: "스윙", hint: "목표·손절(정했으면 보유 기한)에 닿으면 자동으로 팔아요" },
  long: { label: "장기 보유", hint: "자동으로 팔지 않아요. 내가 팔 때까지 보유해요" },
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

// ---------------------------------------------------------------- 투자자 프로필

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
