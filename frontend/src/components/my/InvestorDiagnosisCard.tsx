// 마이: 투자 성향·경험 진단 (7문항, docs/API.md "투자자 프로필과 주린이모드"). 주린이모드 카드 안의 한 구역이다 (BeginnerModeCard).
// 점수·단계·추천은 서버가 계산한다 (PUT). 화면은 "진단 결과: 초급 · 위험중립형 → 주린이모드 켬 추천"을 보이고,
// 추천을 받아들이면 바로 위 스위치가 바뀐다 (PATCH — 끌 때는 한 줄 확인). 법정 적합성 진단이 아니고, 결과는 본인만 본다.
// 폼 ↔ 결과는 같은 자리에서 바뀐다(페이드). 사용자가 바꾼 뒤에만 포커스·스크롤을 옮긴다: 폼을 열면 1번 문항, 닫으면 결과 줄로.
import { type RefObject, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { errorMessage } from "../../api/client";
import { useSubmitInvestorProfile } from "../../api/profile";
import type { InvestorAnswers, InvestorProduct, InvestorProfile } from "../../api/types";
import { useBeginnerMode } from "../../hooks/useBeginnerMode";
import { useChanged, useRevealAfterLoading } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { prefersReducedMotion } from "../../lib/motion";
import { EXPERIENCE_LEVEL_TEXT, INVESTOR_QUESTIONS, NOT_SUITABILITY } from "../../lib/plainText";
import { useToast } from "../toast";
import { ErrorState, Progress, Skeleton, Spinner } from "../ui";
import { ConfirmOff } from "./ConfirmOff";
import { answeredFlags, completeAnswers, type DraftAnswers, resultLine, skippedQuestions, toggleProduct } from "./diagnosis";

/** 결과 줄·빠진 문항을 한 번 물들여 두는 시간(ms). 그 뒤 바탕이 천천히 원래 색으로 돌아간다. */
const HIGHLIGHT_MS = 1200;

const choiceClass = (on: boolean) =>
  cn(
    "press flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-3 text-[15px] font-medium",
    on ? "bg-brand-soft text-brand-ink ring-2 ring-brand" : "bg-fill text-ink hover:bg-line",
  );

const smooth = (): ScrollBehavior => (prefersReducedMotion() ? "auto" : "smooth");

/** 잠깐 켜졌다 꺼지는 표시 (결과 줄·빠진 문항 강조). 켤 때마다 n을 올려 같은 대상도 다시 켠다. */
function useBlink<T>(initial: T | null): [T | null, (v: T) => void] {
  const [on, setOn] = useState<{ v: T; n: number } | null>(initial === null ? null : { v: initial, n: 0 });
  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(() => setOn(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(t);
  }, [on]);
  return [on?.v ?? null, (v: T) => setOn((cur) => ({ v, n: (cur?.n ?? 0) + 1 }))];
}

/**
 * 붙는 바닥(진행·결과 보기)이 화면 아래에 붙어 있는 동안 html[data-sticky-footer]와 잰 높이(--sticky-footer-h)를 단다.
 * 토스트·연결 띠가 그 위로 올라간다 (index.css) — 제출 실패 토스트가 '결과 보기'를 가리지 않게 (my-08). 폼이 닫히면 지운다.
 * 붙어 있는지: 아래 끝이 sticky 자리(화면 높이 − bottom 값 — 모바일은 하단 탭 위, PC는 화면 끝)에 닿아 있고 화면 안에 보일 때.
 */
function useStickyFooterFlag(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    let frame = 0;
    let stuck = false;
    const check = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      const offset = Number.parseFloat(getComputedStyle(el).bottom) || 0;
      const now = r.height > 0 && r.top < window.innerHeight && r.bottom >= window.innerHeight - offset - 1;
      if (now) root.style.setProperty("--sticky-footer-h", `${Math.round(r.height)}px`);
      if (now === stuck) return;
      stuck = now;
      if (now) root.setAttribute("data-sticky-footer", "");
      else root.removeAttribute("data-sticky-footer");
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    ro?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
      root.removeAttribute("data-sticky-footer");
      root.style.removeProperty("--sticky-footer-h");
    };
  }, [ref]);
}

function DiagnosisForm({
  initial,
  focusFirst,
  onDone,
  onCancel,
}: {
  initial: InvestorAnswers | null;
  focusFirst: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const submit = useSubmitInvestorProfile();
  const [draft, setDraft] = useState<DraftAnswers>(() => (initial ? { ...initial, q2: [...initial.q2] } : { q2: [] }));
  const [flash, blink] = useBlink<number>(null);
  const firstLegend = useRef<HTMLLegendElement>(null);
  const blocks = useRef<(HTMLDivElement | null)[]>([]);
  const footer = useRef<HTMLDivElement>(null);
  useStickyFooterFlag(footer);
  const answers = completeAnswers(draft);
  const answered = answeredFlags(draft).filter(Boolean).length;
  const total = INVESTOR_QUESTIONS.length;
  const skipped = skippedQuestions(draft);

  useEffect(() => {
    if (focusFirst) firstLegend.current?.focus();
  }, [focusFirst]);

  // 빠진 문항으로: 화면 가운데로 옮기고 첫 보기에 포커스, 잠깐 물들인다
  const jump = (i: number) => {
    const block = blocks.current[i];
    block?.scrollIntoView?.({ block: "center", behavior: smooth() });
    block?.querySelector("input")?.focus({ preventScroll: true });
    blink(i);
  };

  return (
    <form
      aria-label="투자 성향·경험 진단 문항"
      onSubmit={(e) => {
        e.preventDefault();
        if (!answers || submit.isPending) return;
        submit.mutate(answers, { onSuccess: onDone, onError: (err) => toast(errorMessage(err), "error") });
      }}
    >
      <p className="text-[14px] leading-relaxed text-sub">
        답에 따라 경험 단계({Object.values(EXPERIENCE_LEVEL_TEXT).join("·")})와 투자 성향을 보이고, 주린이모드를 켤지 끌지 추천해요. 진단 전 기본은
        주린이모드 켬이에요.
      </p>
      <div className="mt-4 space-y-3">
        {INVESTOR_QUESTIONS.map((q, i) => (
          <div
            key={q.key}
            ref={(el) => {
              blocks.current[i] = el;
            }}
            className={cn("-mx-2 scroll-mt-16 rounded-xl px-2 py-1.5 transition-colors duration-slow", flash === i && "bg-brand-soft")}
          >
            <fieldset className="space-y-2">
              <legend
                ref={i === 0 ? firstLegend : undefined}
                tabIndex={i === 0 ? -1 : undefined}
                className="mb-2 text-[15px] font-semibold outline-none"
              >
                {i + 1}. {q.text}
              </legend>
              {q.key === "q2" && <p className="-mt-1 text-[13px] text-sub">예적금만은 다른 보기와 함께 고를 수 없어요.</p>}
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                {q.choices.map((c) => {
                  const on = q.multiple ? draft.q2.includes(c.value as InvestorProduct) : draft[q.key] === c.value;
                  return (
                    <label key={c.value} className={choiceClass(on)}>
                      <input
                        type={q.multiple ? "checkbox" : "radio"}
                        name={q.key}
                        value={c.value}
                        checked={on}
                        onChange={() =>
                          setDraft((d) => (q.multiple ? { ...d, q2: toggleProduct(d.q2, c.value as InvestorProduct) } : { ...d, [q.key]: c.value }))
                        }
                        // Tab으로 옮긴 보기가 붙는 바닥(--lift-footer)·연결 띠·하단 탭 밑에 가려지지 않게 비켜 스크롤한다 (a11y-3).
                        // index.css의 :focus-visible 규칙과 같은 값에 보기 칩(44px)이 이 원(16px)보다 아래로 나온 만큼을 더한다 —
                        // 그 규칙만이면 칩 아래가 바닥에 걸린다(실측: 모바일 1px, PC 14px). 바닥 안 버튼에는 두지 않는다(두면 화면이 크게 튄다)
                        className="size-4 shrink-0 scroll-mb-[calc(var(--lift-footer)+var(--lift-offline)+5.5rem+env(safe-area-inset-bottom))] accent-brand lg:scroll-mb-[calc(var(--lift-footer)+var(--lift-offline)+1.5rem)]"
                      />
                      {c.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>
        ))}
      </div>
      {/* 1분이라고 약속했으니 끝이 보여야 한다: 답하는 내내 화면 아래(하단 탭 위)에 붙어 진행·빠진 문항·결과 보기를 보인다.
          붙어 있는 동안 토스트·연결 띠는 이 위로 올라간다 (useStickyFooterFlag) */}
      <div ref={footer} className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] -mx-5 mt-4 border-t border-line bg-card px-5 pt-2.5 pb-3 lg:bottom-0">
        {/* 답한 수는 막대 옆에 (막대를 읽는 숫자). 아래 버튼 줄이 360px 폭에서도 한 줄에 들어간다 — 'n번 외 m개 빠짐'이 길어져도 */}
        <div className="flex items-center gap-3">
          <Progress value={answered} max={total} tone={answers ? "ok" : "brand"} className="min-w-0 flex-1" />
          <span className="shrink-0 text-[13px] font-semibold whitespace-nowrap text-sub tabular-nums">
            {answered}/{total} 답함
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          {skipped.length > 0 && (
            // 보이는 칸은 36px, 누르는 자리는 위아래 4px씩 넓혀 44px
            <button
              type="button"
              onClick={() => jump(skipped[0])}
              className="press relative -my-1 -ml-2 h-9 shrink-0 rounded-lg px-2 text-[13px] font-semibold whitespace-nowrap text-brand-ink before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-brand-soft"
            >
              {skipped[0] + 1}번{skipped.length > 1 ? ` 외 ${skipped.length - 1}개` : ""} 빠짐
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="press ml-auto h-11 shrink-0 rounded-xl bg-fill px-4 text-[15px] font-semibold text-sub hover:bg-line"
          >
            취소
          </button>
          {/* 보내는 중에는 막지(disabled) 않는다: 막으면 포커스가 body로 떨어져 실패했을 때 7문항을 다시 지나야 한다. 다시 누름은 위에서 무시한다 */}
          <button
            type="submit"
            disabled={!answers}
            aria-disabled={submit.isPending || undefined}
            className="press flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark disabled:opacity-40 aria-disabled:cursor-progress"
          >
            {submit.isPending && <Spinner />}
            결과 보기
          </button>
        </div>
      </div>
    </form>
  );
}

function DiagnosisResult({
  profile,
  beginnerMode,
  fresh,
  confirming,
  busy,
  onApplyOn,
  onAskOff,
  onConfirmOff,
  onCancelOff,
}: {
  profile: InvestorProfile;
  beginnerMode: boolean;
  /** 방금 제출한 결과면 결과 줄을 잠깐 물들인다 (어디에 결과가 나왔는지 알려 주려고). */
  fresh: boolean;
  confirming: boolean;
  busy: boolean;
  onApplyOn: () => void;
  onAskOff: () => void;
  onConfirmOff: () => void;
  onCancelOff: () => void;
}) {
  const [lit] = useBlink<true>(fresh ? true : null);
  const [returning, setReturning] = useState(false); // 확인을 취소하면 '추천대로 끄기' 버튼으로 포커스를 돌려준다
  const swapped = useChanged(confirming);
  const line = resultLine(profile);
  const rec = profile.recommendedBeginnerMode;
  return (
    <div className="space-y-2.5">
      <p
        data-focus-after=""
        tabIndex={-1}
        className={cn(
          "rounded-xl px-3.5 py-3 text-[16px] font-bold outline-none transition-colors duration-slow",
          lit ? "bg-brand-soft text-brand-ink" : "bg-fill text-ink",
        )}
      >
        {line}
      </p>
      <p className="text-[13px] text-sub tabular-nums">
        경험 점수 {profile.experienceScore}/11 · 성향 점수 {profile.riskScore}/8 · {formatDateTime(profile.assessedAt)} 진단
      </p>
      {rec !== null && rec !== beginnerMode ? (
        <div key={confirming ? "confirm" : "button"} className={swapped ? "reveal-fade" : undefined}>
          {confirming ? (
            <ConfirmOff
              busy={busy}
              onConfirm={onConfirmOff}
              onCancel={() => {
                setReturning(true);
                onCancelOff();
              }}
            />
          ) : (
            <button
              type="button"
              autoFocus={returning}
              disabled={busy}
              onClick={() => (rec ? onApplyOn() : onAskOff())}
              className="press flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-brand text-[15px] font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
            >
              {busy && <Spinner />}
              추천대로 주린이모드 {rec ? "켜기" : "끄기"}
            </button>
          )}
        </div>
      ) : (
        <p className="text-[14px] text-sub">지금 주린이모드({beginnerMode ? "켬" : "끔"})가 추천과 같아요.</p>
      )}
    </div>
  );
}

/**
 * 진단 구역 (주린이모드 카드 안). '추천대로 끄기'의 확인은 카드가 정한다 (스위치의 확인과 한 번에 하나만 열리게).
 * anchorId: 다른 화면의 '진단하기'(/my#diagnosis)가 가리키는 자리 — 진단 전이면 폼을 펼쳐 둔다. 가리켜 오면 포커스를 받는다 (MyPage).
 * onEdit: 폼을 열 때 (다시 진단). 지금 결과에 대해 연 '추천대로 끄기' 확인을 카드가 닫는다 — 새 결과에 묻지 않은 확인이 남지 않게.
 */
export function InvestorDiagnosis({
  anchorId,
  lit = false,
  confirming,
  busy,
  onApplyOn,
  onAskOff,
  onConfirmOff,
  onCancelOff,
  onEdit,
}: {
  anchorId?: string;
  lit?: boolean;
  confirming: boolean;
  busy: boolean;
  onApplyOn: () => void;
  onAskOff: () => void;
  onConfirmOff: () => void;
  onCancelOff: () => void;
  onEdit?: () => void;
}) {
  const { beginnerMode, profile, profileError, refetchProfile } = useBeginnerMode();
  const { hash } = useLocation();
  const [editing, setEditing] = useState(false);
  const [fresh, setFresh] = useState(false);
  // 사용자가 폼을 열고 닫은 횟수. 0이면 첫 그림이라 포커스·스크롤을 건드리지 않는다
  const [moves, setMoves] = useState(0);
  // '진단하기' 링크(/my#diagnosis)로 왔으면 프로필을 받은 뒤 진단 전일 때 폼을 펼친다 (렌더 중 조건부 파생 상태)
  const [autoOpen, setAutoOpen] = useState(hash === "#diagnosis");
  const loading = !profile && !profileError;
  const reveal = useRevealAfterLoading(loading);
  const section = useRef<HTMLElement>(null);
  const assessed = profile ? resultLine(profile) !== null : false;
  if (autoOpen && profile) {
    setAutoOpen(false);
    if (!assessed) setEditing(true);
  }
  const swapped = useChanged(editing);

  // 폼을 닫으면(결과·취소) 이 구역이 화면 위로 사라지지 않게 데려오고 결과 줄(또는 '진단 시작')로 포커스를 옮긴다
  useEffect(() => {
    if (moves === 0 || editing) return;
    const el = section.current;
    el?.scrollIntoView?.({ block: "nearest", behavior: smooth() });
    el?.querySelector<HTMLElement>("[data-focus-after]")?.focus({ preventScroll: true });
  }, [moves, editing]);

  const open = () => {
    onEdit?.();
    setFresh(false);
    setEditing(true);
    setMoves((n) => n + 1);
  };
  const close = (done: boolean) => {
    setFresh(done);
    setEditing(false);
    setMoves((n) => n + 1);
  };

  return (
    <section
      ref={section}
      id={anchorId}
      tabIndex={anchorId ? -1 : undefined}
      aria-labelledby="diagnosis-title"
      className={cn("-mx-2 scroll-mt-16 rounded-xl px-2 py-1 outline-none transition-colors duration-slow", lit && "bg-brand-soft/60")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="diagnosis-title" className="text-[16px] font-bold">
            투자 성향·경험 진단
          </h3>
          <p className="mt-0.5 text-[13px] leading-snug text-mute">
            1분, 7문항 · {NOT_SUITABILITY} · 결과는 나만 봐요
          </p>
        </div>
        {assessed && !editing && (
          <button
            type="button"
            onClick={open}
            className="press -my-1 h-11 shrink-0 rounded-xl px-3 text-[14px] font-semibold text-brand-ink hover:bg-brand-soft"
          >
            다시 진단
          </button>
        )}
      </div>
      <div className="mt-3">
        {!profile ? (
          profileError ? (
            <ErrorState compact message={errorMessage(profileError)} onRetry={refetchProfile} />
          ) : (
            <Skeleton className="h-11 w-full rounded-xl" />
          )
        ) : (
          <div key={editing ? "form" : "view"} className={swapped || reveal ? "reveal-fade" : undefined}>
            {editing ? (
              <DiagnosisForm initial={profile.answers} focusFirst={moves > 0} onDone={() => close(true)} onCancel={() => close(false)} />
            ) : assessed ? (
              <DiagnosisResult
                profile={profile}
                beginnerMode={beginnerMode}
                fresh={fresh}
                confirming={confirming}
                busy={busy}
                onApplyOn={onApplyOn}
                onAskOff={onAskOff}
                onConfirmOff={onConfirmOff}
                onCancelOff={onCancelOff}
              />
            ) : (
              <button
                type="button"
                data-focus-after=""
                onClick={open}
                className="press h-11 w-full rounded-xl bg-brand text-[15px] font-semibold text-white hover:bg-brand-dark"
              >
                진단 시작
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
