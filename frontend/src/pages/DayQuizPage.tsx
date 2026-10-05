// 단타 연습 퀴즈 /day/quiz (docs/API.md "단타 연습 퀴즈").
//
// useDayQuiz()의 5문항(보기 하나씩 고름) → useSubmitDayQuiz() → 문항별 채점·해설(results) → 5문항 모두 맞으면 통과(passedAt).
// 몇 번이든 다시 풀 수 있다. 정답은 서버만 안다 (이 화면은 GET 응답(정답 없음)과 채점 결과만 쓴다 — 고른 보기만 맞음·틀림으로 칠한다).
// 통과해도 주린이모드가 켜져 있으면 잠김 안내(마이에서 끄기).
//
// 배치: 모바일은 [안내 → (채점 뒤) 결과 → 문항 → 답한 수·채점하기]. 결과가 맨 위라 채점하면 결과 → 1번 해설 순서로 위에서 아래로 읽는다.
// PC(lg)는 왼쪽에 안내·문항(제목과 왼쪽을 맞춤), 오른쪽 칸에 답한 수·채점하기, 채점 뒤에는 결과 — 해설을 내려 읽는 동안 결과와 '다시 풀기'가 붙어 다닌다.
// 채점 버튼을 하단에 고정하지 않는다: 다섯 문항을 차례로 푸는 폼이라 끝에 있는 것이 자연스럽고, 빠진 문항은 '안 푼 문항'이 찾아 준다.
import { type Ref, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { errorMessage } from "../api/client";
import { useDayQuiz, useSubmitDayQuiz } from "../api/profile";
import type { DayQuizQuestion, DayQuizQuestionId, DayQuizResult } from "../api/types";
import { revealIntoView } from "../components/day/dayUtil";
import { Icon } from "../components/Icon";
import { Card, ErrorState, Notice, PageHeader, Progress, SkeletonCard, Spinner } from "../components/ui";
import { useBeginnerMode } from "../hooks/useBeginnerMode";
import { useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { scrollToTop } from "../lib/motion";
import { DAY_LOCK_TEXT } from "../lib/plainText";

// PC 2단: 오른쪽 칸(답한 수·채점하기 / 결과)은 문항을 내려 읽는 동안 붙어 다닌다
const SIDE = "lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start lg:sticky lg:top-8";
const primary = "press flex h-12 w-full items-center justify-center rounded-xl bg-brand text-[15px] font-bold text-white hover:bg-brand-dark";

function ResultCard({
  result,
  questions,
  beginnerMode,
  onRetry,
  onGoTo,
  titleRef,
  className,
}: {
  result: DayQuizResult;
  questions: DayQuizQuestion[];
  beginnerMode: boolean;
  onRetry: () => void;
  onGoTo: (id: string) => void;
  titleRef: Ref<HTMLHeadingElement>;
  className?: string;
}) {
  const number = (id: string) => questions.findIndex((q) => q.id === id) + 1;
  const wrong = result.results.filter((r) => !r.correct);
  return (
    <Card aria-labelledby="quiz-result-title" className={cn("reveal-fade ring-2", result.passed ? "ring-ok" : "ring-line", className)}>
      <h2 id="quiz-result-title" ref={titleRef} tabIndex={-1} className="flex items-center gap-1.5 text-[17px] font-bold outline-none">
        <Icon name={result.passed ? "check-circle" : "circle"} className={cn("size-5", result.passed ? "text-ok" : "text-mute-weak")} />
        {result.passed ? "통과했어요" : "아직 통과하지 못했어요"}
      </h2>
      <p className="mt-1 text-[15px] text-sub">
        {result.total}문항 중 {result.correct}문항 맞혔어요.
      </p>
      {wrong.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-[14px] text-sub">틀린 문항</span>
          {wrong.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onGoTo(r.id)}
              aria-label={`${number(r.id)}번 문항 해설 보기`}
              className="press inline-flex h-11 min-w-11 items-center justify-center gap-0.5 rounded-xl bg-up-soft px-3 text-[14px] font-bold text-up-ink"
            >
              {number(r.id)}번
              <Icon name="chevron" className="size-3.5" />
            </button>
          ))}
        </div>
      )}
      {result.passed ? (
        beginnerMode ? (
          <>
            <Notice className="mt-3">{DAY_LOCK_TEXT.beginner_mode}.</Notice>
            {/* 통과 직후가 다음 단계로 가기 가장 좋은 때라, 글 속 밑줄 링크가 아니라 주 버튼으로 둔다 (끄기는 마이에서만 — 컨셉 4-3) */}
            <Link to="/my" className={cn(primary, "mt-3")}>
              마이로 가기
            </Link>
          </>
        ) : (
          <Link to="/day" className={cn(primary, "mt-3")}>
            단타 연습장으로
          </Link>
        )
      ) : (
        <>
          <p className="mt-3 text-[14px] leading-snug text-sub">5문항을 모두 맞혀야 단타 연습장이 열려요. 해설을 읽고 몇 번이든 다시 풀 수 있어요.</p>
          <button type="button" onClick={onRetry} className={cn(primary, "mt-3")}>
            다시 풀기
          </button>
        </>
      )}
    </Card>
  );
}

export function DayQuizPage() {
  const quiz = useDayQuiz();
  const submit = useSubmitDayQuiz();
  const { beginnerMode, profile } = useBeginnerMode();
  const [answers, setAnswers] = useState<Partial<Record<DayQuizQuestionId, string>>>({});
  const [retries, setRetries] = useState(0);
  const reveal = useRevealAfterLoading(quiz.isPending);
  const form = useRef<HTMLFormElement>(null);
  const resultTitle = useRef<HTMLHeadingElement>(null);
  const result = submit.data ?? null;
  const graded = new Map(result?.results.map((r) => [r.id, r]) ?? []);

  // 채점이 끝나면 결과(맨 위)로: 제목에 포커스(사라진 채점 버튼 대신)를 주고 맨 위로 — 결과 → 1번 해설을 위에서 아래로 읽게
  useEffect(() => {
    if (!result) return;
    resultTitle.current?.focus({ preventScroll: true });
    scrollToTop();
  }, [result]);

  // 다시 풀면 답이 모두 지워지므로 1번 문항부터: 첫 보기에 포커스, 맨 위로
  useEffect(() => {
    if (!retries) return;
    form.current?.querySelector<HTMLInputElement>('input[type="radio"]')?.focus({ preventScroll: true });
    scrollToTop();
  }, [retries]);

  if (quiz.isPending) {
    return (
      <>
        <PageHeader title="단타 연습 퀴즈" back />
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-x-6">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={3} className="lg:col-start-2 lg:row-start-1" />
          <SkeletonCard lines={6} />
        </div>
      </>
    );
  }
  if (quiz.isError) {
    return (
      <>
        <PageHeader title="단타 연습 퀴즈" back />
        <Card>
          <ErrorState message={errorMessage(quiz.error)} onRetry={() => void quiz.refetch()} retrying={quiz.isFetching} />
        </Card>
      </>
    );
  }

  const questions = quiz.data.questions;
  const answered = questions.filter((q) => answers[q.id]).length;
  const missing = questions.map((q, i) => ({ id: q.id, n: i + 1 })).filter((q) => !answers[q.id]);
  const complete = questions.length > 0 && missing.length === 0;
  const retry = () => {
    setAnswers({});
    submit.reset();
    setRetries((n) => n + 1);
  };
  // 그 문항으로: 안 푼 문항은 첫 보기에, 채점 뒤에는 해설 상자에 포커스를 준다 (위 머리에 가리지 않게 scroll-mt)
  const goToQuestion = (id: string) => {
    const radio = form.current?.querySelector<HTMLInputElement>(`input[name="${id}"]`);
    radio?.focus({ preventScroll: true });
    revealIntoView(radio?.closest("fieldset"), "start");
  };
  const goToGrade = (id: string) => {
    const box = document.getElementById(`quiz-grade-${id}`);
    box?.focus({ preventScroll: true });
    revealIntoView(box?.closest("fieldset"), "start");
  };
  // 이미 통과한 사람이 다시 들어왔을 때의 다음 행동 (채점 결과가 있으면 결과 카드가 말한다)
  const next = profile?.dayTradingUnlocked ? { to: "/day", label: "단타 연습장으로" } : beginnerMode ? { to: "/my", label: "마이로 가기" } : null;

  return (
    <>
      <PageHeader title="단타 연습 퀴즈" back />
      {/* 채점 결과 알림: 미리 있던 자리라 화면 읽기 프로그램이 바뀐 내용을 읽는다 (결과 카드는 채점 뒤에 새로 생긴다) */}
      <p aria-live="polite" className="sr-only">
        {result ? `채점했어요. ${result.total}문항 중 ${result.correct}문항을 맞혀 ${result.passed ? "통과했어요" : "아직 통과하지 못했어요"}.` : ""}
      </p>
      <form
        ref={form}
        aria-label="단타 연습 퀴즈"
        onSubmit={(e) => {
          e.preventDefault();
          if (complete && !result && !submit.isPending) submit.mutate(answers as Record<DayQuizQuestionId, string>);
        }}
        className={cn("grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-x-6", reveal && "reveal-fade")}
      >
        <Card className="lg:col-start-1 lg:row-start-1">
          <p className="text-[15px] leading-relaxed">
            단타 연습장은 <b>주린이모드를 끄고</b> 이 퀴즈 <b>5문항을 모두 맞혀야</b> 열려요. 당일 정리·손절·비용·VI·모의 투자의 한계를 묻는 문항이에요.
          </p>
          {quiz.data.passedAt && (
            <>
              <p className="mt-2 flex items-center gap-1 text-[14px] font-semibold text-ok-ink">
                <Icon name="check" className="size-4" />
                {formatDateTime(quiz.data.passedAt)}에 통과했어요 (다시 풀어도 기록은 남아요)
              </p>
              {!result && next && (
                <Link
                  to={next.to}
                  className="press mt-3 flex h-11 items-center justify-center gap-1 rounded-xl bg-fill text-[15px] font-semibold text-ink hover:bg-line"
                >
                  {next.label}
                  <Icon name="chevron" className="size-4" />
                </Link>
              )}
            </>
          )}
        </Card>

        {result && (
          <ResultCard
            result={result}
            questions={questions}
            beginnerMode={beginnerMode}
            onRetry={retry}
            onGoTo={goToGrade}
            titleRef={resultTitle}
            className={SIDE}
          />
        )}

        <div className="space-y-3 lg:col-start-1 lg:row-start-2">
          {questions.map((q, i) => {
            const g = graded.get(q.id);
            return (
              <fieldset key={q.id} className="scroll-mt-20 rounded-2xl bg-card p-5" disabled={result !== null || submit.isPending}>
                <legend className="sr-only">{`${i + 1}. ${q.text}`}</legend>
                <p aria-hidden="true" className="text-[16px] font-bold leading-snug">
                  {i + 1}. {q.text}
                </p>
                <div className="mt-3 space-y-2">
                  {q.choices.map((c) => {
                    const picked = answers[q.id] === c.id;
                    // 서버가 정답 보기를 주지 않으므로 채점 뒤에는 고른 보기만 맞음(초록)·틀림(빨강)으로 칠한다
                    const mark = g && picked ? (g.correct ? "ok" : "bad") : null;
                    return (
                      <label
                        key={c.id}
                        className={cn(
                          "flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[15px] leading-snug transition-colors",
                          g ? "cursor-default" : "cursor-pointer active:bg-line/60",
                          mark === "ok" ? "bg-ok-soft" : mark === "bad" ? "bg-up-soft" : picked ? "bg-brand-soft" : "bg-fill",
                        )}
                      >
                        <input
                          type="radio"
                          name={q.id}
                          value={c.id}
                          checked={picked}
                          onChange={() => setAnswers((cur) => ({ ...cur, [q.id]: c.id }))}
                          className="mt-0.5 size-4 shrink-0 accent-brand"
                        />
                        <span className="min-w-0 flex-1">{c.text}</span>
                        {mark && (
                          <Icon
                            name={mark === "ok" ? "check-circle" : "x-circle"}
                            className={cn("mt-0.5 size-4 shrink-0", mark === "ok" ? "text-ok" : "text-up")}
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
                {g && (
                  <div
                    id={`quiz-grade-${q.id}`}
                    role="group"
                    tabIndex={-1}
                    aria-label={`${i + 1}번 채점`}
                    className={cn("reveal-fade mt-3 rounded-xl px-3.5 py-3 text-[14px] leading-snug outline-none", g.correct ? "bg-ok-soft" : "bg-up-soft")}
                  >
                    <p className={cn("font-bold", g.correct ? "text-ok-ink" : "text-up-ink")}>{g.correct ? "맞았어요" : "틀렸어요"}</p>
                    <p className="mt-0.5 text-sub">{g.explanation}</p>
                  </div>
                )}
              </fieldset>
            );
          })}
        </div>

        {!result && (
          <Card className={cn("space-y-3", SIDE)}>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[15px] font-semibold">답한 문항</p>
              <p className="text-[15px] font-bold tabular-nums">
                {answered} / {questions.length}
              </p>
            </div>
            <Progress value={answered} max={questions.length || 1} label="답한 문항" tone={complete ? "ok" : "brand"} />
            {complete ? null : answered > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-0.5 text-[13px] text-sub">안 푼 문항</span>
                {missing.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => goToQuestion(m.id)}
                    aria-label={`${m.n}번 문항으로`}
                    className="press inline-flex h-11 min-w-11 items-center justify-center rounded-xl bg-fill px-3 text-[14px] font-bold text-ink hover:bg-line"
                  >
                    {m.n}번
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-mute">5문항에 모두 답하면 채점할 수 있어요.</p>
            )}
            {/* 채점하는 동안은 disabled 대신 aria-disabled: 누른 버튼에 포커스가 남는다 (실패하면 오류를 읽고 바로 다시 누른다) */}
            <button
              type="submit"
              disabled={!complete}
              aria-disabled={submit.isPending || undefined}
              aria-busy={submit.isPending || undefined}
              className="press flex h-13 w-full items-center justify-center gap-2 rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark disabled:opacity-40"
            >
              {submit.isPending && <Spinner />}
              채점하기
            </button>
            {submit.isError && <Notice tone="error">{errorMessage(submit.error)}</Notice>}
          </Card>
        )}
      </form>
    </>
  );
}
