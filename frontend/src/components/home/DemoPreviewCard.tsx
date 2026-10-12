import { Link } from "react-router";
import { Icon } from "../Icon";
import { Card } from "../ui";

/**
 * VITE_MOCK=1 전용 발표·디자인 검수 입구. 실제 서비스 빌드에는 표시하지 않는다.
 * 사용자 화면의 첫 자리를 차지하지 않게 홈 맨 아래(보기 바꾸기 뒤)에 낮은 한 줄로 둔다 — PC는 제목·설명 왼쪽, 버튼 셋 오른쪽.
 */
export function DemoPreviewCard() {
  if (import.meta.env.VITE_MOCK !== "1") return null;

  const tool = "press inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold";
  return (
    <Card aria-labelledby="demo-preview-title" className="mt-8 border border-warn/50 bg-warn-soft p-4! @container">
      <div className="flex flex-col gap-3 @min-[720px]:flex-row @min-[720px]:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-warn text-on-warn">
            <Icon name="play" className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 id="demo-preview-title" className="text-[15px] font-bold">
              발표·검수 도구
            </h2>
            <p className="text-[12px] leading-snug text-sub">
              백엔드와 실제 LLM을 호출하지 않고 오류·복구·Feedback Loop 화면을 확인합니다.{" "}
              <span className="font-semibold text-warn-ink">예시 데이터 · 실제 실행 및 비용 발생 없음</span>
            </p>
          </div>
        </div>
        <div className="grid shrink-0 gap-2 sm:grid-cols-3">
          <Link to="/ui/workflows" className={`${tool} bg-ink text-on-ink hover:bg-sub`}>
            <Icon name="play" className="size-4" />
            Agent Workflow 시나리오
          </Link>
          <Link to="/ui/errors" className={`${tool} bg-card text-brand-ink ring-1 ring-line hover:bg-fill`}>
            <Icon name="alert" className="size-4" />
            로딩·오류 상태
          </Link>
          <Link to="/ui/brand" className={`${tool} bg-card text-brand-ink ring-1 ring-line hover:bg-fill`}>
            <Icon name="play" className="size-4" />
            로고·인트로
          </Link>
        </div>
      </div>
    </Card>
  );
}
