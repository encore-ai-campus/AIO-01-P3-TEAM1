// 종목 상세의 "AI 리포트 신청" 버튼 ("AI 분석 요청"과 별개 기능). 신청하면 리포트 상세로 간다.
import { useNavigate } from "react-router";
import { errorMessage } from "../../api/client";
import { useRequestReport } from "../../api/reports";
import { Icon } from "../Icon";
import { Notice, Spinner } from "../ui";

export function ReportRequest({ symbol }: { symbol: string }) {
  const navigate = useNavigate();
  const request = useRequestReport();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-bold">AI 리포트</h2>
          <p className="text-[13px] text-mute">여러 Agent가 협업해 쓰는 종목 리포트. 실행 과정(Trace)을 따라갈 수 있습니다.</p>
        </div>
        <button
          type="button"
          disabled={request.isPending}
          onClick={() => request.mutate(symbol, { onSuccess: (r) => navigate(`/reports/${r.id}`) })}
          className="flex h-11 items-center gap-1.5 rounded-xl bg-fill px-4 text-[15px] font-semibold text-ink hover:bg-line disabled:cursor-not-allowed disabled:opacity-40"
        >
          {request.isPending ? <Spinner /> : <Icon name="doc" className="size-4" />}
          AI 리포트 신청
        </button>
      </div>
      {request.isError && <Notice tone="error">{errorMessage(request.error)}</Notice>}
    </div>
  );
}
