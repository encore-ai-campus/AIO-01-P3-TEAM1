// 홈 카드가 목록에서 무엇을 고르는지 · 3단계 안내의 지금 단계 · 받기 전 자리의 기억 (화면 없이 테스트한다). 알림이 갈 곳은 lib/nav.ts (알림 화면과 같이 쓴다).
import type { ReportSummary, TradePlan } from "../../api/types";

// 알림이 갈 곳·오늘의 내 종목 뉴스 자리는 lib/nav.ts로 옮겼다 (홈 밖 알림 화면도 같은 규칙). 홈 코드는 여기서도 그대로 가져다 쓴다
export { DAILY_MOVE_ANCHOR, notificationHref } from "../../lib/nav";

/** 완성된 리포트 중 자동 리포트를 먼저, 그다음 받은 순서(최신순)로 n개. */
export function pickRecentReports(list: readonly ReportSummary[], n = 3): ReportSummary[] {
  const done = list.filter((r) => r.status === "completed");
  const auto = done.filter((r) => r.source === "auto");
  const rest = done.filter((r) => r.source !== "auto");
  return [...auto, ...rest].slice(0, n);
}

/** 아직 끝나지 않은 리포트 (대기 중·만드는 중). */
export function inProgressReports(list: readonly ReportSummary[]): ReportSummary[] {
  return list.filter((r) => r.status === "requested" || r.status === "running");
}

// ---------------------------------------------------------------- 3단계 안내 (GuideCard)

const GUIDE_KEY = "home-guide-closed";
const guideKeyOf = (userId: number) => `${GUIDE_KEY}:${userId}`;

/** "닫았음"은 이 브라우저에만 남기는 편의 값이다 (저장이 안 되면 다음에 다시 보일 뿐). */
export function readGuideClosed(userId: number): boolean {
  try {
    return localStorage.getItem(guideKeyOf(userId)) === "1";
  } catch {
    return false;
  }
}

/** closed=false면 기록을 지운다 ('3단계 안내 다시 보기'). */
export function writeGuideClosed(userId: number, closed: boolean) {
  try {
    if (closed) localStorage.setItem(guideKeyOf(userId), "1");
    else localStorage.removeItem(guideKeyOf(userId));
  } catch {
    // 저장할 수 없으면 이번 화면에서만 닫는다
  }
}

/** 지금 할 단계. done = 세 단계를 다 해 봤다 (계획이 하나라도 있다 — 진행 중이든 끝났든). */
export type GuideStep = 1 | 2 | "done";

export interface GuideState {
  step: GuideStep;
  /** 지금 할 일 버튼 (done이면 없다) */
  cta: { label: string; to: string } | null;
  /** 1단계에서 리포트를 만드는 중인지 (설명 문장이 달라진다) */
  making: boolean;
  /** 고를 종목 예시를 보일지 (아직 리포트를 하나도 만들지 않았을 때) */
  examples: boolean;
}

export const GUIDE_DONE: GuideState = { step: "done", cta: null, making: false, examples: false };

const GUIDE_HINT_KEY = "home-guide-progress";
const guideHintKeyOf = (userId: number) => `${GUIDE_HINT_KEY}:${userId}`;

/**
 * 안내가 어디까지 갔었는지 (이 브라우저에 남기는 편의 값). 내 리포트·계획을 받기 전 첫 그림을 맞게 그리려고 쓴다 —
 * 처음 쓰는 사람 화면(① 종목 고르기·예시)을 먼저 그렸다가 바뀌면 틀린 버튼이 잠깐 보이고 아래 내용이 밀린다.
 * reports: 예시가 없는 단계다 (만드는 중·검토할 차례 — 할 일 버튼은 받은 뒤에) · done: 다 해 봤다 (처음부터 한 줄).
 * 기억이 없으면 처음 쓰는 사람 화면(예시 있음)이다 — 실패한 리포트만 있는 사람도 같은 화면이라 기억하지 않는다.
 */
export type GuideHint = "reports" | "done";

export function readGuideHint(userId: number): GuideHint | null {
  try {
    const v = localStorage.getItem(guideHintKeyOf(userId));
    return v === "reports" || v === "done" ? v : null;
  } catch {
    return null;
  }
}

/** null이면 지운다 (처음 쓰는 사람과 같은 화면). 저장할 수 없으면 다음에 기본 화면으로 시작할 뿐이다. */
export function writeGuideHint(userId: number, hint: GuideHint | null) {
  try {
    if (hint) localStorage.setItem(guideHintKeyOf(userId), hint);
    else localStorage.removeItem(guideHintKeyOf(userId));
  } catch {
    // 저장할 수 없으면 기억하지 않는다
  }
}

const DIAGNOSED_KEY = "home-diagnosed";

/**
 * 투자 성향 진단을 했는지 (이 브라우저에 남기는 편의 값). 3단계 안내의 '먼저 1분 진단' 한 줄을 프로필을 받기 전부터 맞게 그리려고 쓴다 —
 * 로그인하면 홈으로 오므로 프로필은 안내보다 늦게 온다. 기억이 없으면 처음 쓰는 사람(진단 전) 화면으로 그린다.
 */
export function readDiagnosed(userId: number): boolean {
  try {
    return localStorage.getItem(`${DIAGNOSED_KEY}:${userId}`) === "1";
  } catch {
    return false;
  }
}

export function writeDiagnosed(userId: number, diagnosed: boolean) {
  try {
    if (diagnosed) localStorage.setItem(`${DIAGNOSED_KEY}:${userId}`, "1");
    else localStorage.removeItem(`${DIAGNOSED_KEY}:${userId}`);
  } catch {
    // 저장할 수 없으면 기억하지 않는다
  }
}

/**
 * 받은 상태에서 기억할 진행. 리포트 개수가 아니라 화면(예시가 있는지)으로 정한다 — 실패한 리포트만 있으면 예시가 있는
 * 처음 쓰는 사람 화면인데, 'reports'로 기억하면 다음 방문마다 예시 없이 그렸다가 받은 뒤 예시가 펼쳐지며 아래를 민다.
 */
export function guideHintOf(state: GuideState): GuideHint | null {
  if (state.step === "done") return "done";
  return state.examples ? null : "reports";
}

/**
 * 내 리포트·계획을 받기 전의 첫 그림 (지난번에 기억한 진행으로). null이면 할 일 자리만 그린다 (틀린 버튼을 잠깐이라도 누르게 하지 않게).
 * - done: 처음부터 한 줄 · reports: 할 일 자리만 (예시 없음) · 기억 없음: 처음 쓰는 사람 화면 (① 종목 고르기·예시).
 * - 기억이 reports인데 내 리포트를 받지 못했으면(failed) ① 종목 고르기로 둔다 (리포트가 있던 사람에게는 예시를 보이지 않는다).
 */
export function guideFromHint(hint: GuideHint | null, failed: boolean): GuideState | null {
  if (hint === "done") return GUIDE_DONE;
  if (hint === "reports") return failed ? { ...guideStateOf(undefined, undefined), examples: false } : null;
  return guideStateOf(undefined, undefined);
}

/**
 * 내 리포트·계획으로 안내의 지금 단계와 버튼을 정한다 (아직 받지 않았으면 undefined — 1단계로 본다).
 * - 내 리포트가 있고 계획이 하나라도 있으면(진행 중이든 끝났든) 다 해 봤다.
 *   내 리포트가 하나도 없으면 계획이 있어도 ①이다 — 리포트 0개면 늘 보이는 안내라 '다 해 봤어요'를 닫을 수 없게 되지 않게.
 * - 완성된 내 리포트가 있으면 ② 검토: 가장 최근에 완성된 리포트로.
 * - 만드는 중이면 ①: 그 리포트의 진행 화면으로.
 * - 아무것도 없으면(실패만 있어도) ①: 종목 고르기.
 * ③ 모의 자동매매는 검토한 리포트 화면에서 시작한다 (홈은 '검토'까지 데려간다).
 */
export function guideStateOf(mine: readonly ReportSummary[] | undefined, plans: readonly TradePlan[] | undefined): GuideState {
  const list = mine ?? [];
  if (list.length > 0 && plans && plans.length > 0) return GUIDE_DONE;
  const done = list.find((r) => r.status === "completed");
  if (done) return { step: 2, cta: { label: "내 리포트 검토하기", to: `/reports/${done.id}` }, making: false, examples: false };
  const making = inProgressReports(list)[0];
  if (making) return { step: 1, cta: { label: "만드는 중인 리포트 보기", to: `/reports/${making.id}` }, making: true, examples: false };
  return { step: 1, cta: { label: "종목 고르기", to: "/search" }, making: false, examples: true };
}

// ---------------------------------------------------------------- 받기 전 자리 (스켈레톤)

const SHOWN_KEY = "home-rows";
const shownKeyOf = (userId: number, name: string) => `${SHOWN_KEY}:${userId}:${name}`;

/**
 * 섹션이 지난번에 보인 개수 0~3 (목록 행 수·자산 카드의 기준 시각 줄 수 — 이 브라우저에 남기는 편의 값).
 * 받기 전 스켈레톤을 그만큼 그리려고 쓴다 (homeHooks useShownCount). 없거나 읽을 수 없으면 null.
 */
export function readShownCount(userId: number, name: string): number | null {
  try {
    const v = localStorage.getItem(shownKeyOf(userId, name));
    return v !== null && /^[0-3]$/.test(v) ? Number(v) : null;
  } catch {
    return null;
  }
}

export function writeShownCount(userId: number, name: string, count: number) {
  try {
    localStorage.setItem(shownKeyOf(userId, name), String(Math.min(3, Math.max(0, Math.floor(count)))));
  } catch {
    // 저장할 수 없으면 다음에도 기본 자리로 그린다
  }
}

/** 처음 쓰는 사람이 '무엇을 고를지' 몰라 막히지 않게 보이는 예시 (추천이 아니다 — '예시'로만 부른다). */
export const GUIDE_EXAMPLES = [
  { symbol: "005930", name: "삼성전자" },
  { symbol: "000660", name: "SK하이닉스" },
  { symbol: "035420", name: "NAVER" },
] as const;

// ---------------------------------------------------------------- 날짜 (한국 시간)

const KST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });

/** 한국 시간 날짜 "YYYY-MM-DD" (기본: 지금). */
export function kstDay(at: string | Date = new Date()): string {
  return KST_DAY.format(typeof at === "string" ? new Date(at) : at);
}
