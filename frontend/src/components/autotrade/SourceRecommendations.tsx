// 리포트·분석 상세에 붙는 "이 리포트의 AI 추천 → 계획 활성화"(쉬운 보기: "이 리포트의 새 계획 제안") 카드.
// 그 출처로 만든 추천을 찾는다 (만료 포함). view를 주지 않으면 화면의 보기(useViewMode)를 따른다.
// 카드 안의 추천은 flush(채움 상자)로 — 카드 안에 테두리 카드를 넣어 여백이 이중이 되지 않게 (trade-20).
// keepPrevious를 쓰지 않는다: 리포트 A → B로 옮기면 앞 리포트의 추천이 B 화면에 잠깐 보이면 안 된다.
// 강조 테두리는 기한이 남은(open) 추천이 하나라도 있을 때만 — 지금 할 수 있는 일이 있다는 표시다. 모두 기한이 지났으면
// 강조 없이 접힌 한 줄('제안 1개 · 기한 지남 ⌄')로 두고, 눌러 펼쳐 지난 제안을 본다 (reports-23).
import { useId, useState } from "react";
import type { RecommendationSource } from "../../api/types";
import { useRecommendations } from "../../api/queries";
import { type ViewMode, useViewMode } from "../../hooks/useBeginnerMode";
import { useRevealAfterLoading } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { priceExpiredText } from "../../lib/plainText";
import { Collapse } from "../motion/Collapse";
import { Card } from "../ui";
import { Icon } from "../Icon";
import { RecommendationCard } from "./RecommendationCard";

export function SourceRecommendations({
  source,
  sourceId,
  view,
}: {
  source: Exclude<RecommendationSource, "demo">;
  sourceId: number;
  view?: ViewMode;
}) {
  const screen = useViewMode();
  const easy = (view ?? screen.view) === "easy";
  const { data, isPending } = useRecommendations({ status: "all", source, sourceId }, Number.isFinite(sourceId));
  // 기다린 끝에 나타날 때만 한 번 페이드 (리포트 본문 아래에 늦게 붙는 카드라 툭 끼어들지 않게)
  const reveal = useRevealAfterLoading(isPending);
  const [showPast, setShowPast] = useState(false);
  const listId = useId();
  const list = data?.results ?? [];
  if (list.length === 0) return null;
  const what = source === "report" ? "이 리포트" : "이 분석";
  const titleId = `src-rec-${source}`;
  const title = easy ? `${what}의 새 계획 제안` : `${what}의 AI 추천 → 계획 활성화`;
  const items = (
    <ul className="space-y-2">
      {list.map((r) => (
        <li key={r.id}>
          <RecommendationCard r={r} compact easy={easy} variant="flush" />
        </li>
      ))}
    </ul>
  );

  if (!list.some((r) => r.status === "open")) {
    // 모두 같은 가격 까닭(손절가 이탈·목표가 도달)으로 끝났으면 그 말로, 아니면 '기한 지남' (DECISIONS 25장)
    const reasons = new Set(list.map((r) => r.expiredReason));
    const pastLabel = (reasons.size === 1 ? priceExpiredText(list[0].expiredReason, easy, "short") : null) ?? (easy ? "기한 지남" : "만료");
    // 모두 기한이 지났다: 지금 할 일이 없으니 강조하지 않고 한 줄로 접어 둔다
    return (
      <Card aria-labelledby={titleId} className={reveal ? "reveal-fade" : undefined}>
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold text-sub">
            <Icon name="sparkle" className="size-4 shrink-0 text-mute-weak" />
            {title}
          </h2>
          <button
            type="button"
            aria-expanded={showPast}
            aria-controls={showPast ? listId : undefined}
            onClick={() => setShowPast((v) => !v)}
            className="press -my-2 -mr-2 inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-[14px] font-semibold text-mute hover:bg-line/60 hover:text-sub"
          >
            {list.length}개 · {pastLabel}
            <Icon name="chevron-down" className={cn("size-4 transition-transform duration-fast", showPast && "rotate-180")} />
          </button>
        </div>
        <Collapse open={showPast} id={listId}>
          <div className="pt-3">{items}</div>
        </Collapse>
      </Card>
    );
  }

  return (
    <Card aria-labelledby={titleId} className={cn("ring-2 ring-brand/30", reveal && "reveal-fade")}>
      <h2 id={titleId} className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="sparkle" className="size-5 text-brand" />
        {title}
      </h2>
      <p className="mt-0.5 text-[13px] text-mute">
        {easy
          ? "누르면 넣을 돈을 정하고 몇 주를 사는지 확인한 뒤 모의 자동매매를 시작할 수 있어요."
          : "추천을 누르면 투자 금액을 정해 수량을 확인하고 내 모의 계좌에 자동매매 계획을 켤 수 있습니다."}
      </p>
      <div className="mt-3">{items}</div>
    </Card>
  );
}
