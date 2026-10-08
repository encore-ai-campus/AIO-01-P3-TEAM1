// 만들지 못한 리포트 (쉬운 보기): 실패는 신뢰가 가장 흔들리는 순간이라 "왜 → 무엇을 할 수 있나 → 어디서 멈췄나 → 다시 만들기 → 다른 길" 순서로 보인다.
// 사유는 Trace의 마지막 workflow_failed.details.reason을 쉬운 문장으로. 다음 행동 한 줄은 권유형이 아니라 할 수 있는 일을 말한다.
// "어디서 멈췄는지 보기"는 접어 둔다 (다섯 단계 중 멈춘 곳 — 진행 단계와 자동 복구는 쉬운 보기에서도 숨기지 않는 과제 요소).
// 다시 만들기는 장애 주입 없이 같은 종목으로 (장애 주입 다시 만들기는 전문가 보기). 장애 주입 없이 실패한 리포트는 하루 한도에 세지 않는다 (D-7).
import { useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useReportQuota, useRequestReport } from "../../../api/reports";
import type { ReportDetail } from "../../../api/types";
import { cn } from "../../../lib/cn";
import { errorSentence, failureReasonOf, reportFailureSentence } from "../../../lib/plainText";
import {
  FAILURE_NEXT,
  FAILURE_NEXT_FALLBACK,
  PROGRESS_STATE_TEXT,
  actorLabel,
  type ProgressState,
  progressOf,
  progressStepsOf,
  stoppedStepIndex,
} from "../../../lib/reports";
import { Icon, type IconName } from "../../Icon";
import { Collapse } from "../../motion/Collapse";
import { Card, Notice, Spinner } from "../../ui";
import { QuotaLine } from "../QuotaLine";

interface RowLook {
  text: string;
  icon: IconName;
  dot: string; // 아이콘 원의 바탕·글자
  tone: string; // 상태 글자색
  dim: boolean; // 하지 않은 단계는 이름도 흐리게
}

/**
 * 한 단계의 모양: 멈춘 곳은 강조하고, 그 밖은 그 단계의 실제 상태 (Trace의 마지막 사건 — lib progressOf).
 * 시세·재무·뉴스는 함께(병렬) 돌므로 '멈춘 곳보다 앞이면 끝남'처럼 순서로 정하지 않는다 — 끝난 뉴스를 '하지 않았어요'라고,
 * 포기한 뉴스를 '끝났어요'라고 말하지 않게.
 */
function rowLook(state: ProgressState, here: boolean): RowLook {
  if (here) return { text: "여기서 멈췄어요", icon: "close", dot: "bg-up text-white", tone: "text-up-ink", dim: false };
  switch (state) {
    case "done":
      return { text: PROGRESS_STATE_TEXT.done, icon: "check", dot: "bg-ok text-white", tone: "text-mute", dim: false };
    case "failed":
      return { text: PROGRESS_STATE_TEXT.failed, icon: "close", dot: "bg-up-soft text-up-ink", tone: "text-up-ink", dim: false };
    case "skipped":
      return { text: PROGRESS_STATE_TEXT.skipped, icon: "skip", dot: "bg-line text-mute", tone: "text-mute", dim: true };
    case "active":
      // 같이 돌던 단계가 멈춘 곳과 함께 끊겼다 (엔진 재시작 등)
      return { text: "하다가 멈췄어요", icon: "pause", dot: "bg-line text-mute", tone: "text-mute", dim: false };
    case "again":
      // 검토 AI가 고쳐 쓰게 한 뒤 다시 보기 전에 멈췄다
      return { text: "다시 보기 전에 멈췄어요", icon: "pause", dot: "bg-line text-mute", tone: "text-mute", dim: false };
    default:
      return { text: "하지 않았어요", icon: "circle", dot: "bg-line text-mute", tone: "text-mute", dim: true };
  }
}

/** 다섯 단계 중 멈춘 곳(강조)과, 단계마다 실제로 끝났는지·못 했는지·건너뛰었는지·하지 않았는지. */
function StoppedSteps({ r, reason }: { r: ReportDetail; reason: string | null }) {
  const defs = progressStepsOf(r.team);
  const steps = progressOf(r.trace, r.team);
  const stop = stoppedStepIndex(steps, reason, r.trace);
  return (
    // aria-label이 진행 화면의 '진행 단계'와 다르다 (같은 화면에 둘이 함께 있지 않지만 이름으로 구별되게)
    <ol aria-label="멈춘 단계" className="space-y-1.5">
      {steps.map((s, i) => {
        const here = i === stop;
        const look = rowLook(s.state, here);
        return (
          <li
            key={s.actor}
            aria-current={here ? "step" : undefined}
            data-state={s.state}
            className={cn("flex items-center gap-2.5 rounded-xl px-3 py-2", here ? "bg-up-soft" : "bg-fill")}
          >
            <span className={cn("grid size-6 shrink-0 place-items-center rounded-full", look.dot)}>
              <Icon name={look.icon} className="size-3.5" />
            </span>
            <span className={cn("min-w-0 flex-1 text-[14px] font-semibold", look.dim && "text-mute")}>{defs[i].noun}</span>
            <span className={cn("shrink-0 text-[13px] font-semibold", look.tone)}>{look.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function EasyFailure({ r }: { r: ReportDetail }) {
  const navigate = useNavigate();
  const request = useRequestReport();
  const quota = useReportQuota();
  const [open, setOpen] = useState(false);
  const stepsId = useId();
  const full = quota.data?.remaining === 0;
  const reason = failureReasonOf(r.trace);
  return (
    <Card aria-labelledby="failure-title" className="space-y-3 border-2 border-up/40">
      <h2 id="failure-title" className="flex items-center gap-1.5 text-[18px] font-bold text-up-ink">
        <Icon name="alert" className="size-5" />
        리포트를 만들지 못했어요
      </h2>
      {/* 왜 → 무엇을 할 수 있나 */}
      <div className="space-y-1">
        <p className="text-[15px] leading-snug text-ink">{reportFailureSentence(reason)}</p>
        <p className="text-[14px] leading-snug text-sub">{(reason && FAILURE_NEXT[reason]) || FAILURE_NEXT_FALLBACK}</p>
      </div>

      {/* 어디서 멈췄나 (접힘) */}
      <div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? stepsId : undefined}
          onClick={() => setOpen((v) => !v)}
          className="press -ml-1.5 inline-flex h-11 items-center gap-1 rounded-lg px-1.5 text-[14px] font-semibold text-brand-ink hover:bg-fill"
        >
          어디서 멈췄는지 보기
          <Icon name="chevron-down" className={cn("size-4 transition-transform duration-fast", open && "rotate-180")} />
        </button>
        <Collapse open={open} id={stepsId} className="mt-1">
          <StoppedSteps r={r} reason={reason} />
          {Object.keys(r.state.errors).length > 0 && (
            <div className="mt-2 rounded-xl bg-fill px-3 py-2.5">
              <p className="text-[13px] font-bold">실패한 Agent와 이유</p>
              <ul className="mt-1 space-y-1 text-[13px] text-sub">
                {Object.entries(r.state.errors).map(([agent, message]) => (
                  <li key={agent} className="break-words">
                    <b>{actorLabel(r.plan, agent)}</b> · {message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Collapse>
      </div>

      {!(r.chaosEnabled || r.chaos?.enabled) && (
        <p className="text-[13px] leading-snug text-sub">만들지 못한 리포트는 오늘 만들 수 있는 횟수에 세지 않아요.</p>
      )}
      <button
        type="button"
        disabled={request.isPending || full}
        onClick={() => request.mutate({ symbol: r.symbol }, { onSuccess: (n) => navigate(`/reports/${n.id}`) })}
        className="press flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
      >
        {request.isPending ? <Spinner /> : <Icon name="restart" className="size-5" />}
        다시 만들기
      </button>
      <QuotaLine className="text-center" />
      {request.isError && <Notice tone="error">{errorSentence(request.error)}</Notice>}
      {/* 다른 길: 목록으로 (다른 종목을 고르거나 팀 리포트를 본다) */}
      <Link
        to="/reports"
        className="press mx-auto flex h-11 w-fit items-center gap-0.5 rounded-lg px-3 text-[14px] font-semibold text-sub hover:bg-fill"
      >
        리포트 목록으로
        <Icon name="chevron" className="size-4" />
      </Link>
    </Card>
  );
}
