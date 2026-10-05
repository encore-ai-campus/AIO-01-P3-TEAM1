// 한 덩어리 카드(내 자산·랭킹·오늘의 내 종목 뉴스·3단계 안내)의 머리: 카드 안 제목(17px) + 오른쪽 '전체 보기 ›'.
// 목록 섹션은 카드 밖 SectionHead(19px)를 쓴다 — 무엇이 섹션이고 무엇이 카드 하나인지 머리 모양으로 갈린다.
// quiet: 제목보다 숫자가 주인공인 카드(내 자산)는 제목을 작고 흐리게, '전체 보기' 글자 없이 › 만.
// stretch: 링크가 카드 전체를 덮는다 (카드에 relative, 다른 링크·버튼이 없을 때만). 누름·포커스 모양은 STRETCH_CARD를 카드에 준다.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { Icon, type IconName } from "../Icon";

/** 링크가 덮은 카드 전체가 누름·hover·키보드 포커스에 반응하게 (카드에 준다). */
export const STRETCH_CARD =
  "relative transition-colors hover:bg-fill/40 has-[a:active]:bg-fill has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-brand";

export function CardHeader({
  id,
  title,
  icon,
  to,
  more = "전체 보기",
  quiet = false,
  stretch = false,
  right,
}: {
  id: string;
  title: ReactNode;
  icon?: IconName;
  to?: string;
  more?: string;
  quiet?: boolean;
  stretch?: boolean;
  /** 링크가 없을 때 오른쪽 (배지·닫기 버튼 등) */
  right?: ReactNode;
}) {
  const heading = (
    <h2 id={id} className={cn("flex min-w-0 items-center gap-1.5", quiet ? "text-[15px] font-semibold text-sub" : "text-[17px] font-bold")}>
      {icon && <Icon name={icon} className="size-5 shrink-0" />}
      {title}
    </h2>
  );
  if (!to) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        {heading}
        {right}
      </div>
    );
  }
  return (
    <Link
      to={to}
      className={cn(
        // 보이는 크기는 그대로(음수 여백), 누르는 자리는 44px
        "-m-2 flex min-h-11 items-center justify-between gap-3 rounded-xl p-2",
        stretch
          ? "outline-none after:absolute after:inset-0 after:rounded-2xl after:content-['']"
          : "press-row hover:bg-fill/60",
      )}
    >
      {heading}
      <span className="flex shrink-0 items-center gap-0.5 text-[14px] font-semibold text-mute">
        {!quiet && more}
        <Icon name="chevron" className={quiet ? "size-5 text-mute-weak" : "size-4"} />
      </span>
    </Link>
  );
}
