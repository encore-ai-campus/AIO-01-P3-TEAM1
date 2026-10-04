// 만들지 못한 리포트 (쉬운 보기): 실패 사유 코드(Trace의 마지막 workflow_failed.details.reason)를 쉬운 문장으로 + "다시 만들기".
// 다시 만들기는 장애 주입 없이 같은 종목으로 (장애 주입 다시 만들기는 전문가 보기). 장애 주입 없이 실패한 리포트는 하루 한도에 세지 않는다 (D-7).
import { useNavigate } from "react-router";
import { useReportQuota, useRequestReport } from "../../../api/reports";
import type { ReportDetail } from "../../../api/types";
import { errorSentence, failureReasonOf, reportFailureSentence } from "../../../lib/plainText";
import { Icon } from "../../Icon";
import { Card, Notice, Spinner } from "../../ui";
import { QuotaLine } from "../QuotaLine";

export function EasyFailure({ r }: { r: ReportDetail }) {
  const navigate = useNavigate();
  const request = useRequestReport();
  const quota = useReportQuota();
  const full = quota.data?.remaining === 0;
  return (
    <Card aria-labelledby="failure-title" className="space-y-3 border-2 border-up/40">
      <h2 id="failure-title" className="flex items-center gap-1.5 text-[18px] font-bold text-up">
        <Icon name="alert" className="size-5" />
        리포트를 만들지 못했어요
      </h2>
      <p className="text-[15px] leading-snug text-ink">{reportFailureSentence(failureReasonOf(r.trace))}</p>
      {!(r.chaosEnabled || r.chaos?.enabled) && (
        <p className="text-[13px] leading-snug text-mute">만들지 못한 리포트는 오늘 만들 수 있는 횟수에 세지 않아요.</p>
      )}
      <button
        type="button"
        disabled={request.isPending || full}
        onClick={() => request.mutate({ symbol: r.symbol }, { onSuccess: (n) => navigate(`/reports/${n.id}`) })}
        className="flex h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
      >
        {request.isPending ? <Spinner /> : <Icon name="restart" className="size-5" />}
        다시 만들기
      </button>
      <QuotaLine className="text-center" />
      {request.isError && <Notice tone="error">{errorSentence(request.error)}</Notice>}
    </Card>
  );
}
