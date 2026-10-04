// 쉬운 보기 홈의 "최근 알림" 3개. 누르면 읽음 처리 + 알림의 link로 간다 (알림 화면과 같은 동작).
import { useNavigate } from "react-router";
import { useMarkRead } from "../../api/autotrade";
import { useNotifications } from "../../api/queries";
import type { Notification } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/format";
import { notificationKindText } from "../../lib/plainText";
import { Skeleton } from "../ui";
import { SectionHead } from "./SectionHead";

export function RecentNotifications() {
  const navigate = useNavigate();
  const { data, isPending } = useNotifications(false);
  const read = useMarkRead();
  const list = (data?.results ?? []).slice(0, 3);
  const open = (n: Notification) => {
    if (!n.readAt) read.mutate({ ids: [n.id] });
    navigate(n.link ?? "/notifications");
  };
  return (
    <section aria-labelledby="home-noti-title" className="space-y-3">
      <SectionHead id="home-noti-title" title="최근 알림" to="/notifications" more="전체 보기" />
      {isPending ? (
        <Skeleton className="h-20 w-full rounded-2xl" />
      ) : list.length === 0 ? (
        <p className="rounded-2xl bg-card px-5 py-4 text-[15px] text-mute">아직 알림이 없어요. 리포트가 완성되거나 모의 자동매매가 움직이면 여기에 보여요.</p>
      ) : (
        <ul aria-label="최근 알림 목록" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {list.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => open(n)}
                className={cn("block w-full px-5 py-3.5 text-left hover:bg-fill/60", !n.readAt && "bg-brand-soft/40")}
              >
                <span className="flex items-center gap-1.5 text-[12px] font-semibold text-mute">
                  {notificationKindText(n.kind)}
                  {!n.readAt && <span className="rounded bg-up px-1 text-[11px] leading-[18px] font-bold text-white">안 읽음</span>}
                  <span className="ml-auto font-normal">{formatRelative(n.createdAt)}</span>
                </span>
                <span className={cn("mt-0.5 block truncate text-[15px]", n.readAt ? "font-medium text-sub" : "font-bold text-ink")}>{n.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
