import { Link } from "react-router";
import { Icon } from "../Icon";
import { Card } from "../ui";

/** VITE_MOCK=1 전용 발표·디자인 검수 입구. 실제 서비스 빌드에는 표시하지 않는다. */
export function DemoPreviewCard() {
  if (import.meta.env.VITE_MOCK !== "1") return null;

  return (
    <Card aria-labelledby="demo-preview-title" className="mb-6 border-2 border-warn/50 bg-warn-soft">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-warn text-on-warn">
          <Icon name="play" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="demo-preview-title" className="text-[17px] font-bold">발표·검수 도구</h2>
          <p className="mt-1 text-[13px] leading-snug text-sub">
            백엔드와 실제 LLM을 호출하지 않고, 평소에는 보기 어려운 오류·복구·Feedback Loop 화면을 확인합니다.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <Link to="/ui/workflows" className="press flex min-h-12 items-center justify-center gap-1.5 rounded-xl bg-ink px-4 text-[14px] font-semibold text-on-ink hover:bg-sub">
          <Icon name="play" className="size-4" />
          Agent Workflow 시나리오
        </Link>
        <Link to="/ui/errors" className="press flex min-h-12 items-center justify-center gap-1.5 rounded-xl bg-card px-4 text-[14px] font-semibold text-brand-ink ring-1 ring-line hover:bg-fill">
          <Icon name="alert" className="size-4" />
          로딩·오류 상태
        </Link>
        <Link to="/ui/brand" className="press flex min-h-12 items-center justify-center gap-1.5 rounded-xl bg-card px-4 text-[14px] font-semibold text-brand-ink ring-1 ring-line hover:bg-fill">
          <Icon name="play" className="size-4" />
          로고·인트로
        </Link>
      </div>
      <p className="mt-2 text-[12px] font-semibold text-warn-ink">예시 데이터 · 실제 실행 및 비용 발생 없음</p>
    </Card>
  );
}
