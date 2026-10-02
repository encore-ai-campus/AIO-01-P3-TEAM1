import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, errorMessage } from "../api/client";
import { keys, useJob, useQuota } from "../api/queries";
import { formatUsd } from "../lib/format";
import { Icon } from "./Icon";
import { Notice, Spinner } from "./ui";

/** "AI 분석 요청" 버튼: 남은 횟수·예상 비용 → 요청 → 작업 상태 5초 폴링 → 끝나면 분석 상세로. */
export function AnalysisRequest({ symbol, name }: { symbol: string; name: string }) {
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
        <div>
          <h2 className="text-[17px] font-bold">AI 분석</h2>
          <p className="text-[13px] text-mute">
            {quota
              ? quota.enabled
                ? `오늘 남은 횟수 ${quota.remaining}회 · 예상 비용 약 ${formatUsd(quota.estimatedCostUsd)}`
                : "AI 키가 없어 분석을 요청할 수 없습니다."
              : "남은 횟수를 확인하는 중…"}
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => request.mutate()}
          className="flex h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running || request.isPending ? <Spinner /> : <Icon name="sparkle" className="size-4" />}
          AI 분석 요청
        </button>
      </div>

      {running && (
        <Notice>
          <p>
            {name} 분석 중입니다 ({job?.status === "RUNNING" ? "진행 중" : "대기 중"}). 몇 분 걸리며, 끝나면 분석 결과로 이동합니다.
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
