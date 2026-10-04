// 리포트·분석 상세에 붙는 "이 리포트의 AI 추천 → 계획 활성화"(쉬운 보기: "이 리포트의 새 계획 제안") 카드.
// 그 출처로 만든 추천을 찾는다 (만료 포함). view를 주지 않으면 화면의 보기(useViewMode)를 따른다.
import type { RecommendationSource } from "../../api/types";
import { useRecommendations } from "../../api/queries";
import { type ViewMode, useViewMode } from "../../hooks/useBeginnerMode";
import { Card } from "../ui";
import { Icon } from "../Icon";
import { RecommendationCard } from "./RecommendationCard";

export function SourceRecommendations({
  source,
  sourceId,
  view,
}: {
  source: Exclude<RecommendationSource, "demo" | "day">;
  sourceId: number;
  view?: ViewMode;
}) {
  const screen = useViewMode();
  const easy = (view ?? screen.view) === "easy";
  const { data } = useRecommendations({ status: "all", source, sourceId }, Number.isFinite(sourceId));
  const list = data?.results ?? [];
  if (list.length === 0) return null;
  const what = source === "report" ? "이 리포트" : "이 분석";
  return (
    <Card aria-labelledby={`src-rec-${source}`} className="ring-2 ring-brand/30">
      <h2 id={`src-rec-${source}`} className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="sparkle" className="size-5 text-brand" />
        {easy ? `${what}의 새 계획 제안` : `${what}의 AI 추천 → 계획 활성화`}
      </h2>
      <p className="mt-0.5 text-[13px] text-mute">
        {easy
          ? "누르면 안전장치가 내 모의 계좌로 정한 수량과 금액을 확인하고 모의 자동매매를 시작할 수 있어요."
          : "추천을 누르면 리스크 엔진이 정한 수량을 확인하고 내 모의 계좌에 자동매매 계획을 켤 수 있습니다."}
      </p>
      <ul className="mt-3 space-y-2">
        {list.map((r) => (
          <li key={r.id} className="rounded-2xl border border-line">
            <RecommendationCard r={r} compact easy={easy} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
