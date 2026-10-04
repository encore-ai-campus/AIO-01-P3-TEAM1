import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, errorMessage } from "../api/client";
import { keys, useJob, useQuota } from "../api/queries";
import { formatUsd } from "../lib/format";
import { Icon } from "./Icon";
import { Notice, Spinner } from "./ui";

/**
 * 종목 상세의 보조 버튼 "AI 교차검증 분석" (docs/DECISIONS.md 13-1 D-1 — 큰 버튼 "AI 리포트 만들기" 아래).
 * 남은 횟수 → 요청 → 작업 상태 5초 폴링 → 끝나면 분석 상세(여러 AI가 서로 검증한 과정)로.
 * easy면 쉬운 설명 (비용 표시 없이 남은 횟수만).
 */
export function AnalysisRequest({ symbol, name, easy = false }: { symbol: string; name: string; easy?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: quota } = useQuota();
  const [jobId, setJobId] = useState<number | null>(null);
  const { data: job, error: jobError } = useJob(jobId);

  const request = useMutation({
    mutationFn: () => api.post<{ jobId: number }>("/api/analyses", { symbol }),
    onSuccess: (res) => {
      setJobId(res.jobId);
      void qc.invalidateQueries({ queryKey: keys.quota });
    },
  });

  const doneId = job?.status === "DONE" ? (job.result?.analysisIds[0] ?? null) : null;
  useEffect(() => {
    if (doneId === null) return;
    void qc.invalidateQueries({ queryKey: ["analyses"] });
    navigate(`/analyses/${doneId}`);
  }, [doneId, navigate, qc]);

  const running = jobId !== null && (!job || job.status === "QUEUED" || job.status === "RUNNING");
  const failed = job?.status === "FAILED" || (job?.status === "DONE" && doneId === null);
  const disabled = !quota || !quota.enabled || quota.remaining <= 0 || running || request.isPending;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold">교차검증 분석</h2>
          <p className="text-[13px] leading-snug text-sub">
            {easy
              ? "AI 여러 곳이 각자 계획을 내고 서로 검증하는 과정을 볼 수 있어요. 몇 분 걸려요."
              : "여러 모델이 시나리오를 내고 교차검증 → 리스크 엔진 → 최종 승인을 거칩니다."}
          </p>
          <p className="text-[13px] text-mute">
            {quota
              ? quota.enabled
                ? easy
                  ? `오늘 남은 횟수 ${quota.remaining}회`
                  : `오늘 남은 횟수 ${quota.remaining}회 · 예상 비용 약 ${formatUsd(quota.estimatedCostUsd)}`
                : "AI 키가 없어 분석을 요청할 수 없습니다."
              : "남은 횟수를 확인하는 중…"}
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => request.mutate()}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-fill px-4 text-[15px] font-semibold text-ink hover:bg-line disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running || request.isPending ? <Spinner /> : <Icon name="sparkle" className="size-4 text-brand" />}
          AI 교차검증 분석
        </button>
      </div>

      {running && (
        <Notice>
          <p>
            {name} 교차검증 분석 중입니다 ({job?.status === "RUNNING" ? "진행 중" : "대기 중"}). 몇 분 걸리며, 끝나면 분석 결과로 이동합니다.
          </p>
        </Notice>
      )}
      {request.isError && <Notice tone="error">{errorMessage(request.error)}</Notice>}
      {jobError && <Notice tone="error">{errorMessage(jobError)}</Notice>}
      {failed && <Notice tone="error">분석에 실패했습니다: {job?.error ?? "결과가 없습니다."}</Notice>}
      {quota && quota.enabled && quota.remaining <= 0 && !running && (
        <p className="text-[13px] text-mute">
          오늘 요청 한도({quota.limitPerUser}회)를 다 썼습니다. 내일 다시 요청할 수 있습니다.
        </p>
      )}
    </div>
  );
}
