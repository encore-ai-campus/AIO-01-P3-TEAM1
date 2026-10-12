// 쉬운 보기 홈의 3단계 안내 (docs/plans/컨셉변경계획.md 4-2): ① 리포트 만들기 → ② 검토 → ③ 모의 자동매매.
// 지금 어느 단계인지 따라간다 — 끝낸 단계 ✓ · 지금 단계(aria-current="step") · 다음 단계, 버튼도 지금 할 일로 (homeData guideStateOf).
// 모바일은 가로 단계 표시 + 지금 단계 설명 하나만(첫 화면을 덜 차지), 넓으면 세 단계 설명을 다 보인다 (카드 폭 기준 @container).
// 내 리포트·계획을 받기 전에는 지난번에 본 진행(homeData readGuideHint)으로 그린다 — 처음 쓰는 사람 화면을 먼저 그렸다가 바꾸면
// 틀린 버튼·예시가 잠깐 보이고, 다 해 본 사람은 큰 카드가 한 줄로 줄며 아래 내용이 수백 px 올라온다.
// 보일지·닫았는지는 HomePage가 정한다 (닫으면 접히며 사라지고, 맨 아래 '3단계 안내 다시 보기'로 되살린다).
// 진단 전이면 단계 목록 위에 '먼저 1분 진단' 한 줄을 둔다 (docs/plans/투자서비스확장계획.md 2-1 '처음 로그인하면 진단을 권한다 — 건너뛸 수 있음').
// 안내 위에 카드를 하나 더 쌓지 않는다 — '보기를 고르고 → 3단계'가 한 덩어리로 읽히게. 마이는 /my#diagnosis로 오면 진단 폼을 펼친다.
import { type FocusEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useInvestorProfile } from "../../api/profile";
import { usePlans } from "../../api/queries";
import type { ReportSummary } from "../../api/types";
import { useChanged } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { Icon } from "../Icon";
import { Collapse } from "../motion/Collapse";
import { Card, Skeleton } from "../ui";
import {
  GUIDE_EXAMPLES,
  type GuideState,
  guideFromHint,
  guideHintOf,
  guideStateOf,
  readDiagnosed,
  readGuideHint,
  writeDiagnosed,
  writeGuideHint,
} from "./homeData";
import { useChangedSinceKnown } from "./homeHooks";

/** 안내 첫 줄: 무엇으로 연습하는지·무엇을 되돌릴 수 없는지 (팀원마다 모의 계좌가 따로다 — docs/DECISIONS.md 8-1). */
const GUIDE_LINE = "내 모의 계좌 1,000만 원으로 연습해요 · 진짜 돈이 아니고, 계좌를 처음으로 되돌릴 수는 없어요";

const STEPS = [
  { n: 1, title: "리포트 만들기", body: "종목을 고르고 \"AI 리포트 만들기\"를 눌러요. 닫아도 계속 만들어요." },
  { n: 2, title: "검토", body: "AI 의견·근거·위험과 손절에 팔면 잃는 금액을 읽어요." },
  { n: 3, title: "모의 자동매매", body: "확인을 마치면 모의 계좌에서 정해 둔 가격대로 사고팔아요." },
] as const;

const MAKING_LINE = "AI가 리포트를 만들고 있어요. 완성되면 알림으로 알려 드려요 — 그다음은 ② 검토예요.";
const REVIEW_LINE = "완성된 내 리포트에서 AI 의견·근거·위험을 읽어요. 다 읽은 뒤 그 화면에서 ③ 모의 자동매매를 시작할 수 있어요.";

/** 진단 전 한 줄: 진단하면 나에게 맞는 보기(주린이모드 켬·끔)를 추천받는다. 프로필을 받은 뒤 진단 전일 때만 펼쳐진다. */
function DiagnosisHint({ open }: { open: boolean }) {
  return (
    <Collapse open={open}>
      <div className="pt-3">
        <p className="flex items-center gap-2 rounded-xl bg-brand-soft py-1.5 pr-1.5 pl-3.5 text-[14px] leading-snug text-brand-ink">
          <span id="guide-diagnosis" className="min-w-0 flex-1">
            먼저 1분 진단으로 나에게 맞는 보기를 추천받을 수 있어요
          </span>
          <Link
            to="/my#diagnosis"
            aria-describedby="guide-diagnosis"
            className="press inline-flex h-10 shrink-0 items-center gap-0.5 rounded-lg bg-card pr-2 pl-3 text-[14px] font-semibold text-brand-ink hover:bg-fill"
          >
            진단하기
            <Icon name="chevron" className="size-4" />
          </Link>
        </p>
      </div>
    </Collapse>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="안내 닫기"
      onClick={onClose}
      className="-mt-1.5 -mr-2 grid size-11 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-fill active:bg-line/60"
    >
      <Icon name="close" className="size-5" />
    </button>
  );
}

/**
 * 3단계 안내 카드. mine: 내 리포트 (아직 받지 않았으면 undefined — 닫기 버튼 자리만 비워 둔다). failed: 내 리포트를 받지 못했다.
 * 내 리포트가 있어야 닫을 수 있다 (0개면 늘 보이는 안내). 계획을 하나라도 만들었으면 '다 해 봤어요' 한 줄로 줄어든다.
 */
export function GuideCard({
  userId,
  mine,
  failed = false,
  onClose,
}: {
  userId: number;
  mine: readonly ReportSummary[] | undefined;
  failed?: boolean;
  onClose: () => void;
}) {
  const plans = usePlans("all");
  // 진단 전인지는 프로필을 받아야 안다. 받기 전에는 이 브라우저의 기억으로 (기억이 없으면 진단 전 — 처음 쓰는 사람 화면),
  // 받지 못했으면 권하지 않는다. 진단한 사람에게 한 줄이 잠깐 보였다 접히거나, 진단 전인 사람의 단계 목록이 뒤늦게 밀리지 않게
  const profile = useInvestorProfile();
  const [rememberedDiagnosed] = useState(() => readDiagnosed(userId));
  const assessed = profile.data ? profile.data.assessedAt !== null : null;
  const askDiagnosis = assessed === null ? !rememberedDiagnosed && !profile.isError : !assessed;
  useEffect(() => {
    if (assessed !== null) writeDiagnosed(userId, assessed);
  }, [userId, assessed]);
  // 지금 단계는 내 리포트와 계획을 다 받아야 안다 (계획을 받지 못했으면 계획 없음으로 본다)
  const known = mine !== undefined && !plans.isPending;
  const real = known ? guideStateOf(mine, plans.data?.results) : null;
  // 받기 전: 지난번에 본 진행으로 (homeData guideFromHint). 다 해 봤으면 처음부터 한 줄, 예시가 없는 단계면 할 일 자리만(버튼은 받은 뒤에),
  // 기억이 없으면 처음 쓰는 사람 화면
  const [hint] = useState(() => readGuideHint(userId));
  const g: GuideState | null = real ?? guideFromHint(hint, failed);
  const remember = real && plans.isSuccess ? guideHintOf(real) : undefined;
  useEffect(() => {
    if (remember !== undefined) writeGuideHint(userId, remember);
  }, [userId, remember]);

  const canClose = mine !== undefined && mine.length > 0;
  const current = g === null ? 0 : g.step === "done" ? 4 : g.step;
  // 단계가 넘어가는 순간(받아 둔 값이 바뀜)만 체크가 튀어나오고 할 일이 페이드된다.
  // 첫 렌더·캐시로 바로 그린 화면·받기 전 자리에서 처음 알게 된 단계는 그대로 (방금 그 단계를 끝낸 것처럼 보이지 않게)
  const moved = useChangedSinceKnown(g === null ? undefined : current);
  const stepKey = g === null ? "pending" : `${g.step}|${g.making}|${g.cta?.to ?? ""}`;
  const swapped = useChanged(stepKey);

  // 키보드·화면 읽기의 자리 지키기: 할 일이 바뀌어도 버튼(Link)은 다시 만들지 않아 포커스가 그대로 남는다.
  // 카드 안에 포커스가 있었는데 그 요소가 사라졌으면(한 줄 '다 해 봤어요'로 줄어 버튼이 없어짐 등 — body로 떨어진다) 새 할 일 버튼, 없으면 제목으로 옮긴다.
  // 사라진 요소의 blur는 React에 오지 않으므로(문서에서 떨어진 뒤) focusIn은 그대로 true다
  const focusIn = useRef(false);
  const ctaRef = useRef<HTMLAnchorElement>(null);
  useLayoutEffect(() => {
    if (!focusIn.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return; // 아직 카드 안(버튼 그대로)이거나 사용자가 옮긴 곳
    (ctaRef.current ?? document.getElementById("guide-title"))?.focus({ preventScroll: true });
  }, [stepKey]);
  const trackFocus = {
    onFocus: () => {
      focusIn.current = true;
    },
    onBlur: (e: FocusEvent<HTMLDivElement>) => {
      focusIn.current = e.currentTarget.contains(e.relatedTarget);
    },
  };

  if (g?.step === "done") {
    return (
      <div {...trackFocus}>
        <Card aria-labelledby="guide-title" className="flex items-center gap-3 py-4">
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-ok-soft text-ok">
            <Icon name="check" className={cn("size-5", moved && "animate-pop-in")} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="guide-title" tabIndex={-1} className="text-[16px] font-bold outline-none">
              3단계를 모두 해 봤어요
            </h2>
            <p className="text-[13px] text-sub">리포트 만들기 → 검토 → 모의 자동매매</p>
          </div>
          <CloseButton onClose={onClose} />
        </Card>
      </div>
    );
  }

  // 지금 상황에 맞춘 한 줄 (만드는 중·검토할 차례). 없으면 단계 설명
  const extra = g?.making ? MAKING_LINE : g?.step === 2 ? REVIEW_LINE : null;
  return (
    <div {...trackFocus}>
      <Card aria-labelledby="guide-title" className="@container">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="guide-title" tabIndex={-1} className="text-[19px] font-bold outline-none">
              3단계로 연습해요
            </h2>
            <p className="mt-1 text-[14px] leading-snug text-balance text-sub">{GUIDE_LINE}</p>
          </div>
          {/* 닫기 자리는 늘 둔다: 리포트를 받은 뒤 버튼이 나타나도 제목 줄이 다시 줄바꿈되지 않게 */}
          {canClose ? <CloseButton onClose={onClose} /> : <span aria-hidden="true" className="-mt-1.5 -mr-2 size-11 shrink-0" />}
        </div>

        {/* 단계 목록 밖 (단계는 세 개 그대로) */}
        <DiagnosisHint open={askDiagnosis} />

        <ol aria-label="연습 순서" className="mt-4 grid grid-cols-3 gap-x-2">
          {STEPS.map((s, i) => {
            const state = s.n < current ? "done" : s.n === current ? "now" : "next";
            return (
              <li key={s.n} aria-current={state === "now" ? "step" : undefined} className="relative flex flex-col items-center text-center">
                {i < STEPS.length - 1 && (
                  // 다음 단계로 잇는 선: 끝낸 단계면 파랗게 채운다 (가운데 원 사이, 칸 간격 8px까지)
                  <span aria-hidden="true" className="absolute top-3.5 right-[calc(-50%+12px)] left-[calc(50%+20px)] h-0.5 overflow-hidden rounded-full bg-line">
                    {/* 단계가 실제로 넘어갈 때만 채워지며 움직인다 (처음 알게 된 단계는 그대로 그린다) */}
                    <span
                      className={cn("block h-full origin-left bg-brand", moved && "transition-[scale] duration-base ease-standard")}
                      style={{ scale: state === "done" ? "1 1" : "0 1" }}
                    />
                  </span>
                )}
                <span
                  aria-hidden="true"
                  className={cn(
                    "relative grid size-7 place-items-center rounded-full text-[14px] font-bold transition-colors duration-base",
                    state === "done" && "bg-brand-soft text-brand-ink",
                    state === "now" && "bg-brand text-white ring-4 ring-brand-soft",
                    state === "next" && "bg-fill text-mute",
                  )}
                >
                  {state === "done" ? <Icon name="check" className={cn("size-4", moved && "animate-pop-in")} /> : s.n}
                </span>
                <span className={cn("mt-2 block text-[14px] leading-tight", state === "now" ? "font-bold text-ink" : "font-semibold text-sub")}>
                  <span className="sr-only">{`${s.n}단계: `}</span>
                  {s.title}
                  {/* 지금 단계는 aria-current가 알린다. 끝낸 단계는 체크(장식) 대신 글자로 */}
                  {state === "done" && <span className="sr-only"> (완료)</span>}
                </span>
                {/* 넓은 카드: 세 단계 설명을 다 보인다 */}
                <span className="mt-1 hidden text-[13px] leading-snug text-sub @min-[480px]:block">{s.body}</span>
              </li>
            );
          })}
        </ol>

        {/* 지금 할 일(설명 + 버튼): 단계가 바뀐 순간(내 리포트를 받아 '만드는 중'임을 알게 된 때 등)에만 한 번 페이드된다.
            다시 그리는(key) 것은 글자뿐 — 버튼(Link)은 그대로 두어 그 위의 키보드 포커스가 body로 사라지지 않게 */}
        <div className="mt-4 space-y-4">
          {g === null ? (
            // 할 일을 아직 모른다 (내 리포트를 받는 중): 같은 높이의 자리만 — 틀린 버튼을 잠깐이라도 누르게 하지 않는다
            <div role="group" aria-busy="true" aria-label="불러오는 중" className="space-y-4">
              <div className="space-y-1.5 rounded-xl bg-fill px-4 py-3 @min-[480px]:hidden">
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-2/3" />
              </div>
              <Skeleton className="hidden h-[43px] rounded-xl @min-[480px]:block" />
              <Skeleton className="h-12 rounded-xl" />
            </div>
          ) : (
            <>
              {/* 좁은 카드(모바일)는 지금 단계 설명 하나만, 넓은 카드는 상황 한 줄이 있을 때만 (단계 설명은 위 칸에 다 있다) */}
              <p
                key={`now-${stepKey}`}
                className={cn("rounded-xl bg-fill px-4 py-3 text-[14px] leading-snug text-sub @min-[480px]:hidden", swapped && "reveal-fade")}
              >
                {extra ?? STEPS[current - 1].body}
              </p>
              {extra && (
                <p
                  key={`extra-${stepKey}`}
                  className={cn("hidden rounded-xl bg-fill px-4 py-3 text-[14px] leading-snug text-sub @min-[480px]:block", swapped && "reveal-fade")}
                >
                  {extra}
                </p>
              )}
              {g.cta && (
                <Link
                  ref={ctaRef}
                  to={g.cta.to}
                  // 받기 전 자리에서 처음 나타날 때만 버튼째 페이드 (그 뒤 단계가 바뀌면 버튼은 그대로, 안의 글자만)
                  className={cn(
                    "press flex h-12 items-center justify-center rounded-xl bg-brand text-[15px] font-semibold text-white hover:bg-brand-dark",
                    swapped && "reveal-fade",
                  )}
                >
                  <span key={stepKey} className={cn("flex items-center gap-1.5", swapped && "reveal-fade")}>
                    <Icon name={g.cta.to === "/search" ? "search" : "doc"} className="size-5" />
                    {g.cta.label}
                  </span>
                </Link>
              )}
            </>
          )}
        </div>

        {/* 무엇을 고를지 몰라 빈 검색 화면에서 막히지 않게 — 두 번 눌러 'AI 리포트 만들기'까지 간다 (추천이 아니라 예시).
            아직 만든 적이 없을 때만 — 리포트를 받아 보니 있으면 접혀 사라진다 (간격도 접히는 안쪽에) */}
        <Collapse open={g?.examples ?? false}>
          <div className="pt-4">
            <p className="text-[13px] text-mute">예시로 눌러 보기</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {GUIDE_EXAMPLES.map((e) => (
                <Link
                  key={e.symbol}
                  to={`/stocks/${e.symbol}`}
                  className="press relative inline-flex h-9 items-center rounded-full bg-fill px-3.5 text-[14px] font-semibold text-sub before:absolute before:-inset-1 hover:bg-line"
                >
                  {e.name}
                </Link>
              ))}
            </div>
          </div>
        </Collapse>
      </Card>
    </div>
  );
}
