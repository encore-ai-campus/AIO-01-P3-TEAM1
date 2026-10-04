// 종목 상세의 "AI 리포트 신청" 버튼 ("AI 분석 요청"과 별개 기능). 누르면 신청 폼(장애 주입 포함)이 바텀시트(PC는 모달)로 열린다.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { errorMessage } from "../../api/client";
import { useReportPlan } from "../../api/queries";
import { useRequestReport } from "../../api/reports";
import type { ChaosRequest } from "../../api/types";
import { Icon } from "../Icon";
import { Notice, Spinner } from "../ui";
import { ChaosForm } from "./ChaosForm";

function RequestSheet({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const navigate = useNavigate();
  const request = useRequestReport();
  const { data: plan } = useReportPlan();
  const [chaos, setChaos] = useState<ChaosRequest | null>(null);
  const workers = plan ? plan.workers.filter((w) => plan.steps.some((s) => s.workers.includes(w.id))) : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center lg:items-center">
      <button type="button" aria-label="닫기" onClick={onClose} className="absolute inset-0 bg-ink/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-sheet-title"
        className="relative max-h-[85dvh] w-full animate-sheet-up overflow-y-auto rounded-t-3xl bg-card p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] lg:max-w-md lg:animate-none lg:rounded-3xl"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="report-sheet-title" className="text-[18px] font-bold">
            AI 리포트 신청
          </h2>
          <button type="button" aria-label="닫기" onClick={onClose} className="grid size-9 place-items-center rounded-full hover:bg-fill">
            <Icon name="close" className="size-5" />
          </button>
        </div>
        <ChaosForm value={chaos} onChange={setChaos} workers={workers} />
        {request.isError && (
          <Notice tone="error" className="mt-3">
            {errorMessage(request.error)}
          </Notice>
        )}
        <button
          type="button"
          disabled={request.isPending}
          onClick={() => request.mutate({ symbol, chaos }, { onSuccess: (r) => navigate(`/reports/${r.id}`) })}
          className="mt-4 flex h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand text-[16px] font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
        >
          {request.isPending ? <Spinner /> : <Icon name="doc" className="size-4" />}
          신청하기
        </button>
      </div>
    </div>
  );
}

export function ReportRequest({ symbol }: { symbol: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[17px] font-bold">AI 리포트</h2>
        <p className="text-[13px] text-mute">여러 Agent가 협업해 쓰는 종목 리포트. 실행 과정(Trace)을 따라갈 수 있습니다.</p>
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-11 items-center gap-1.5 rounded-xl bg-fill px-4 text-[15px] font-semibold text-ink hover:bg-line"
      >
        <Icon name="doc" className="size-4" />
        AI 리포트 신청
      </button>
      {open && <RequestSheet symbol={symbol} onClose={() => setOpen(false)} />}
    </div>
  );
}
