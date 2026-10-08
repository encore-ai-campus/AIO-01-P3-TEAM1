// 하루 리포트 한도 한 줄 (D-7): "오늘 ○번 더 만들 수 있어요" / "오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요" (무제한이면 "횟수 제한 없이").
// 한도를 받기 전에도 같은 높이의 자리를 둔다 (늦게 끼어들어 아래 목록·출처 줄을 밀지 않게). 받지 못하면(오류) 아무것도 그리지 않는다.
import { useReportQuota } from "../../api/reports";
import { cn } from "../../lib/cn";
import { quotaSentence } from "../../lib/reports";
import { Skeleton } from "../ui";

export function QuotaLine({ className }: { className?: string }) {
  const { data, isPending } = useReportQuota();
  if (!data) {
    return isPending ? (
      <div aria-hidden="true" className={cn("flex h-5 items-center justify-center", className)}>
        <Skeleton className="h-3.5 w-40" />
      </div>
    ) : null;
  }
  return (
    <p aria-live="polite" className={cn("min-h-5 text-[13px] font-medium", data.remaining !== 0 ? "text-sub" : "text-warn-ink", className)}>
      {quotaSentence(data)}
    </p>
  );
}
