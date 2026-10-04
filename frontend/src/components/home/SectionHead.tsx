// 홈·마이 묶음의 머리: 제목 + 오른쪽 "더 보기" 링크.
import { Link } from "react-router";
import { Icon } from "../Icon";

export function SectionHead({ id, title, to, more }: { id: string; title: string; to?: string; more?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <h2 id={id} className="text-[19px] font-bold">
        {title}
      </h2>
      {to && more && (
        <Link to={to} className="flex shrink-0 items-center gap-0.5 text-[14px] font-semibold text-mute hover:text-sub">
          {more}
          <Icon name="chevron" className="size-4" />
        </Link>
      )}
    </div>
  );
}
