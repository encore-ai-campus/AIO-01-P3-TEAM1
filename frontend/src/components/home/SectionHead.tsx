// 홈 목록 섹션의 머리: 카드 밖 제목(19px) + 개수 + 오른쪽 '전체 보기 ›'. 한 덩어리 카드(자산·랭킹·뉴스·안내)는 CardHeader.
// 제목은 tabIndex -1: 위 카드가 닫힐 때(3단계 안내 닫기) 포커스를 받는 자리다.
import { Link } from "react-router";
import { Icon } from "../Icon";

export function SectionHead({ id, title, to, count, more = "전체 보기" }: { id: string; title: string; to?: string; count?: number; more?: string }) {
  const shownCount = count !== undefined && count > 0 ? count : null;
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <div className="flex min-w-0 items-center gap-2">
        <h2 id={id} tabIndex={-1} className="truncate text-[19px] font-bold outline-none">
          {title}
        </h2>
        {shownCount !== null && (
          <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-line/70 px-2 text-[13px] font-bold text-sub tabular-nums">
            {shownCount}
            <span className="sr-only">개</span>
          </span>
        )}
      </div>
      {to && (
        // 보이는 크기는 그대로(음수 여백), 누르는 자리는 44px
        <Link
          to={to}
          aria-label={`${title} ${more}${shownCount !== null ? `, ${shownCount}개` : ""}`}
          className="press -my-2 -mr-2 inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-lg px-2 text-[14px] font-semibold text-mute hover:bg-line/60 hover:text-sub active:bg-line"
        >
          {more}
          <Icon name="chevron" className="size-4" />
        </Link>
      )}
    </div>
  );
}
