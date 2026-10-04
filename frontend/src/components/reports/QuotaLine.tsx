// 하루 리포트 한도 한 줄 (D-7): "오늘 ○번 더 만들 수 있어요" / "오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요".
// 한도 API(GET /api/reports/quota)를 받지 못하면 아무것도 그리지 않는다.
import { useReportQuota } from "../../api/reports";
import { cn } from "../../lib/cn";
import { quotaSentence } from "../../lib/reports";

export function QuotaLine({ className }: { className?: string }) {
  const { data } = useReportQuota();
  if (!data) return null;
  return (
    <p aria-live="polite" className={cn("text-[13px] font-medium", data.remaining > 0 ? "text-sub" : "text-[#9a5b00]", className)}>
      {quotaSentence(data)}
    </p>
  );
}
