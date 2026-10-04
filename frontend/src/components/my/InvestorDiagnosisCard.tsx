// 마이: 투자 성향·경험 진단 (7문항, docs/API.md "투자자 프로필과 주린이모드").
// 점수·단계·추천은 서버가 계산한다 (PUT). 화면은 "진단 결과: 초급 · 위험중립형 → 주린이모드 켬 추천"을 보이고,
// 추천을 받아들이면 주린이모드를 바꾼다 (PATCH — 끌 때는 한 줄 확인). 법정 적합성 진단이 아니고, 결과는 본인만 본다.
import { useState } from "react";
import { errorMessage } from "../../api/client";
import { useSubmitInvestorProfile } from "../../api/profile";
import type { InvestorAnswers, InvestorProduct, InvestorProfile } from "../../api/types";
import { useBeginnerMode } from "../../hooks/useBeginnerMode";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { EXPERIENCE_LEVEL_TEXT, INVESTOR_QUESTIONS, NOT_SUITABILITY } from "../../lib/plainText";
import { useToast } from "../toast";
import { Card, ErrorState, SkeletonCard, Spinner } from "../ui";
import { ConfirmOff } from "./ConfirmOff";
import { useApplyBeginnerMode } from "./useApplyBeginnerMode";
import { completeAnswers, type DraftAnswers, resultLine, toggleProduct } from "./diagnosis";

const choiceClass = (on: boolean) =>
  cn(
    "flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-3 text-[15px] font-medium",
    on ? "bg-brand-soft text-brand-dark ring-2 ring-brand" : "bg-fill text-ink hover:bg-line",
  );

function DiagnosisForm({ initial, onDone, onCancel }: { initial: InvestorAnswers | null; onDone: () => void; onCancel?: () => void }) {
  const toast = useToast();
  const submit = useSubmitInvestorProfile();
  const [draft, setDraft] = useState<DraftAnswers>(() => (initial ? { ...initial, q2: [...initial.q2] } : { q2: [] }));
  const answers = completeAnswers(draft);
  const answered = INVESTOR_QUESTIONS.filter((q) => (q.key === "q2" ? draft.q2.length > 0 : draft[q.key] !== undefined)).length;
  return (
    <form
      className="space-y-5"
      aria-label="투자 성향·경험 진단 문항"
      onSubmit={(e) => {
        e.preventDefault();
        if (!answers) return;
        submit.mutate(answers, { onSuccess: onDone, onError: (err) => toast(errorMessage(err), "error") });
      }}
    >
      {INVESTOR_QUESTIONS.map((q, i) => (
        <fieldset key={q.key} className="space-y-2">
          <legend className="mb-2 text-[15px] font-semibold">
            {i + 1}. {q.text}
          </legend>
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
                    className="size-4 shrink-0 accent-brand"
                  />
                  {c.label}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="flex items-center gap-2 border-t border-line pt-4">
        <span className="mr-auto text-[13px] text-mute tabular-nums">
          {answered}/{INVESTOR_QUESTIONS.length} 답함
        </span>
        {onCancel && (
          <button type="button" onClick={onCancel} className="h-11 rounded-xl bg-fill px-4 text-[15px] font-semibold text-sub hover:bg-line">
            취소
          </button>
        )}
        <button
          type="submit"
          disabled={!answers || submit.isPending}
          className="flex h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
        >
          {submit.isPending && <Spinner />}
          결과 보기
        </button>
      </div>
    </form>
  );
}

function DiagnosisResult({ profile, beginnerMode, onRetake }: { profile: InvestorProfile; beginnerMode: boolean; onRetake: () => void }) {
  const { apply, isPending } = useApplyBeginnerMode();
  const [confirming, setConfirming] = useState(false);
  const line = resultLine(profile);
  const rec = profile.recommendedBeginnerMode;
  return (
    <div className="space-y-3">
      <p className="rounded-xl bg-fill px-3.5 py-3 text-[16px] font-bold">{line}</p>
      <p className="text-[13px] text-mute tabular-nums">
        경험 점수 {profile.experienceScore}/11 · 성향 점수 {profile.riskScore}/8 · {formatDateTime(profile.assessedAt)} 진단
      </p>
      {rec !== null && rec !== beginnerMode ? (
        confirming ? (
          <ConfirmOff
            busy={isPending}
            onConfirm={() => {
              setConfirming(false);
              apply(false);
            }}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <button
            type="button"
            disabled={isPending}
            onClick={() => (rec ? apply(true) : setConfirming(true))}
            className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-brand text-[15px] font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
          >
            {isPending && <Spinner />}
            추천대로 주린이모드 {rec ? "켜기" : "끄기"}
          </button>
        )
      ) : (
        <p className="text-[14px] text-sub">지금 주린이모드({beginnerMode ? "켬" : "끔"})가 추천과 같아요.</p>
      )}
      <button type="button" onClick={onRetake} className="h-11 w-full rounded-xl bg-fill text-[15px] font-semibold text-ink hover:bg-line">
        다시 진단
      </button>
    </div>
  );
}

export function InvestorDiagnosisCard() {
  const { beginnerMode, profile, profileError, refetchProfile } = useBeginnerMode();
  const [editing, setEditing] = useState(false);
  if (!profile) {
    if (!profileError) return <SkeletonCard lines={4} />;
    return (
      <Card aria-labelledby="diagnosis-title">
        <h2 id="diagnosis-title" className="text-[17px] font-bold">
          투자 성향·경험 진단
        </h2>
        <ErrorState message={errorMessage(profileError)} onRetry={refetchProfile} />
      </Card>
    );
  }
  const assessed = resultLine(profile) !== null;
  return (
    <Card aria-labelledby="diagnosis-title" className="space-y-4">
      <div>
        <h2 id="diagnosis-title" className="text-[17px] font-bold">
          투자 성향·경험 진단
        </h2>
        <p className="mt-1 text-[13px] leading-snug text-mute">
          1분, 7문항 · {NOT_SUITABILITY} · 결과는 나만 봐요
        </p>
      </div>
      {editing ? (
        <DiagnosisForm initial={profile.answers} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
      ) : assessed ? (
        <DiagnosisResult profile={profile} beginnerMode={beginnerMode} onRetake={() => setEditing(true)} />
      ) : (
        <div className="space-y-3">
          <p className="text-[15px] leading-relaxed text-sub">
            답에 따라 경험 단계({Object.values(EXPERIENCE_LEVEL_TEXT).join("·")})와 투자 성향을 보이고, 주린이모드를 켤지 끌지 추천해요.
            진단 전 기본은 주린이모드 켬이에요.
          </p>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="h-11 w-full rounded-xl bg-brand text-[15px] font-semibold text-white hover:bg-brand-dark"
          >
            진단 시작
          </button>
        </div>
      )}
    </Card>
  );
}
