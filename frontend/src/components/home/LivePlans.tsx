// 쉬운 보기 홈의 "진행 중인 모의 자동매매": 계획마다 쉬운 상태 이름과 한 줄 설명 (lib/plainText.ts).
// 전문가 보기 홈은 components/autotrade/HomeSummaries.tsx의 HomePlans (원래 용어·가격).
import { Link } from "react-router";
import { usePlans } from "../../api/queries";
import { cn } from "../../lib/cn";
import { formatQty } from "../../lib/format";
import { PLAN_STATUS_TEXT, SOURCE_TEXT } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Skeleton } from "../ui";
import { SectionHead } from "./SectionHead";

export function LivePlans() {
  const { data, isPending } = usePlans("active");
  const list = data?.results ?? [];
  return (
    <section aria-labelledby="home-live-title" className="space-y-3">
      <SectionHead id="home-live-title" title="진행 중인 모의 자동매매" to="/portfolio" more={list.length > 0 ? `${list.length}건` : "모의투자"} />
      {isPending ? (
        <Skeleton className="h-20 w-full rounded-2xl" />
      ) : list.length === 0 ? (
        <p className="rounded-2xl bg-card px-5 py-4 text-[15px] text-mute">
          진행 중인 모의 자동매매가 없어요. 리포트를 검토한 뒤 시작할 수 있어요.
        </p>
      ) : (
        <ul aria-label="진행 중인 모의 자동매매 목록" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {list.slice(0, 3).map((p) => {
            const s = PLAN_STATUS_TEXT[p.status];
            return (
              <li key={p.id}>
                <Link to={`/plans/${p.id}`} aria-label={`${p.name} 모의 자동매매 보기`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-fill/60">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-9 shrink-0 place-items-center rounded-full",
                      p.status === "holding" ? "bg-brand text-white" : "bg-brand-soft text-brand-dark",
                    )}
                  >
                    <Icon name={p.status === "holding" ? "shield" : "clock"} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-1.5">
                      <span className="truncate text-[16px] font-semibold">{p.name}</span>
                      <span className="text-[13px] font-semibold text-brand-dark">{s?.easy ?? p.status}</span>
                    </span>
                    <span className="mt-0.5 block text-[13px] leading-snug text-sub">{s?.line}</span>
                    <span className="mt-0.5 block text-[12px] text-mute tabular-nums">
                      {formatQty(p.quantity)} · {SOURCE_TEXT[p.source]?.label ?? p.source}
                    </span>
                  </span>
                  <Icon name="chevron" className="size-4 shrink-0 text-mute" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
