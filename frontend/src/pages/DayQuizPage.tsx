// 단타 연습 퀴즈 /day/quiz (docs/API.md "단타 연습 퀴즈").
//
// useDayQuiz()의 5문항(보기 하나씩 고름) → useSubmitDayQuiz() → 문항별 채점·해설(results) → 5문항 모두 맞으면 통과(passedAt).
// 몇 번이든 다시 풀 수 있다. 정답은 서버만 안다 (이 화면은 GET 응답(정답 없음)과 채점 결과만 쓴다).
// 통과해도 주린이모드가 켜져 있으면 잠김 안내(마이에서 끄기).
import { useState } from "react";
import { Link } from "react-router";
import { errorMessage } from "../api/client";
import { useDayQuiz, useSubmitDayQuiz } from "../api/profile";
import type { DayQuizQuestionId, DayQuizResult } from "../api/types";
import { Icon } from "../components/Icon";
import { Card, ErrorState, Notice, PageHeader, SkeletonCard, Spinner } from "../components/ui";
import { useBeginnerMode } from "../hooks/useBeginnerMode";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { DAY_LOCK_TEXT } from "../lib/plainText";

function ResultCard({ result, beginnerMode, onRetry }: { result: DayQuizResult; beginnerMode: boolean; onRetry: () => void }) {
  return (
    <Card aria-labelledby="quiz-result-title" className={cn("ring-2", result.passed ? "ring-ok" : "ring-line")}>
      <h2 id="quiz-result-title" className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name={result.passed ? "check" : "circle"} className={cn("size-5", result.passed ? "text-ok" : "text-mute")} />
        {result.passed ? "통과했어요" : "아직 통과하지 못했어요"}
      </h2>
      <p role="status" className="mt-1 text-[15px] text-sub">
        {result.total}문항 중 {result.correct}문항 맞혔어요.
      </p>
      {result.passed ? (
        beginnerMode ? (
          <Notice className="mt-3">
            {DAY_LOCK_TEXT.beginner_mode}.{" "}
            <Link to="/my" className="font-semibold underline">
              마이로 가기
            </Link>
          </Notice>
        ) : (
          <Link
            to="/day"
            className="mt-3 flex h-12 items-center justify-center rounded-xl bg-brand text-[15px] font-bold text-white hover:bg-brand-dark"
          >
            단타 연습장으로
          </Link>
        )
      ) : (
        <>
          <p className="mt-2 text-[14px] text-sub">5문항을 모두 맞혀야 단타 연습장이 열려요. 해설을 읽고 몇 번이든 다시 풀 수 있어요.</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 flex h-12 w-full items-center justify-center rounded-xl bg-fill text-[15px] font-semibold text-sub hover:bg-line"
          >
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
  const { beginnerMode } = useBeginnerMode();
  const [answers, setAnswers] = useState<Partial<Record<DayQuizQuestionId, string>>>({});
  const result = submit.data ?? null;
  const graded = new Map(result?.results.map((r) => [r.id, r]) ?? []);

  if (quiz.isPending) {
    return (
      <>
        <PageHeader title="단타 연습 퀴즈" back />
        <SkeletonCard lines={8} />
      </>
    );
  }
  if (quiz.isError) {
    return (
      <>
        <PageHeader title="단타 연습 퀴즈" back />
        <Card>
          <ErrorState message={errorMessage(quiz.error)} onRetry={() => void quiz.refetch()} />
        </Card>
      </>
    );
  }

  const questions = quiz.data.questions;
  const complete = questions.length > 0 && questions.every((q) => answers[q.id]);
  const retry = () => {
    setAnswers({});
    submit.reset();
  };

  return (
    <>
      <PageHeader title="단타 연습 퀴즈" back />
      <div className="mx-auto max-w-2xl space-y-3">
        <Card>
          <p className="text-[15px] leading-relaxed">
            단타 연습장은 <b>주린이모드를 끄고</b> 이 퀴즈 <b>5문항을 모두 맞혀야</b> 열려요. 당일 정리·손절·비용·VI·모의 투자의 한계를 묻는 문항이에요.
          </p>
          {quiz.data.passedAt && (
            <p className="mt-2 flex items-center gap-1 text-[14px] font-semibold text-ok">
              <Icon name="check" className="size-4" />
              {formatDateTime(quiz.data.passedAt)}에 통과했어요 (다시 풀어도 기록은 남아요)
            </p>
          )}
        </Card>

        <form
          aria-label="단타 연습 퀴즈"
          onSubmit={(e) => {
            e.preventDefault();
            if (complete && !result) submit.mutate(answers as Record<DayQuizQuestionId, string>);
          }}
          className="space-y-3"
        >
          {questions.map((q, i) => {
            const g = graded.get(q.id);
            return (
              <fieldset key={q.id} className="rounded-2xl bg-card p-5" disabled={result !== null || submit.isPending}>
                <legend className="sr-only">{`${i + 1}. ${q.text}`}</legend>
                <p aria-hidden="true" className="text-[16px] font-bold leading-snug">
                  {i + 1}. {q.text}
                </p>
                <div className="mt-3 space-y-2">
                  {q.choices.map((c) => (
                    <label
                      key={c.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-2.5 rounded-xl px-3.5 py-3 text-[15px] leading-snug",
                        answers[q.id] === c.id ? "bg-brand-soft" : "bg-fill",
                      )}
                    >
                      <input
                        type="radio"
                        name={q.id}
                        value={c.id}
                        checked={answers[q.id] === c.id}
                        onChange={() => setAnswers((cur) => ({ ...cur, [q.id]: c.id }))}
                        className="mt-0.5 size-4 shrink-0 accent-brand"
                      />
                      <span>{c.text}</span>
                    </label>
                  ))}
                </div>
                {g && (
                  <div
                    aria-label={`${i + 1}번 채점`}
                    className={cn("mt-3 rounded-xl px-3.5 py-3 text-[14px] leading-snug", g.correct ? "bg-ok-soft" : "bg-up-soft")}
                  >
                    <p className={cn("font-bold", g.correct ? "text-ok" : "text-up")}>{g.correct ? "맞았어요" : "틀렸어요"}</p>
                    <p className="mt-0.5 text-sub">{g.explanation}</p>
                  </div>
                )}
              </fieldset>
            );
          })}

          {!result && (
            <button
              type="submit"
              disabled={!complete || submit.isPending}
              className="flex h-13 w-full items-center justify-center gap-2 rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark disabled:opacity-40"
            >
              {submit.isPending && <Spinner />}
              채점하기
            </button>
          )}
          {!complete && !result && <p className="text-center text-[13px] text-mute">5문항에 모두 답하면 채점할 수 있어요.</p>}
          {submit.isError && <Notice tone="error">{errorMessage(submit.error)}</Notice>}
        </form>

        {result && <ResultCard result={result} beginnerMode={beginnerMode} onRetry={retry} />}
      </div>
    </>
  );
}
