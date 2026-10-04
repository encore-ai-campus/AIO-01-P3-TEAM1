// /notifications: 내 알림 (최신순, 안 읽은 것 강조). 누르면 읽음 처리 + link로 이동. "모두 읽음".
// 알림마다 종류 이름(lib/plainText.ts NOTIFICATION_KIND_TEXT)을 보인다. 문장은 서버가 받는 사람의 주린이모드에 맞춰 만든다.
import { Link, useNavigate } from "react-router";
import { useMarkRead } from "../api/autotrade";
import { errorMessage } from "../api/client";
import { useNotifications } from "../api/queries";
import type { Notification } from "../api/types";
import { Icon, type IconName } from "../components/Icon";
import { useToast } from "../components/toast";
import { Card, EmptyState, ErrorState, PageHeader, SkeletonCard } from "../components/ui";
import { cn } from "../lib/cn";
import { formatRelative } from "../lib/format";
import { notificationKindText } from "../lib/plainText";

const KIND_ICON: Record<string, IconName> = {
  recommendation: "sparkle",
  plan_activated: "bolt",
  order_placed: "doc",
  order_requeued: "restart",
  filled: "check",
  closed: "check",
  cancelled: "ban",
  expired: "clock",
  failed: "alert",
  system: "bell",
  report_completed: "doc",
  report_failed: "alert",
  daily_move: "chart",
  thesis_check: "shield",
};

export function NotificationsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isPending, isError, error, refetch } = useNotifications(false);
  const read = useMarkRead();
  const list = data?.results ?? [];
  const unread = data?.unreadCount ?? 0;

  const openItem = (n: Notification) => {
    if (!n.readAt) read.mutate({ ids: [n.id] });
    if (n.link) navigate(n.link);
  };

  return (
    <>
      <PageHeader
        title="알림"
        back
        right={
          unread > 0 ? (
            <button
              type="button"
              disabled={read.isPending}
              onClick={() => read.mutate({ all: true }, { onSuccess: () => toast("알림을 모두 읽음으로 표시했습니다."), onError: (e) => toast(errorMessage(e), "error") })}
              className="h-9 shrink-0 rounded-xl bg-card px-3 text-[14px] font-semibold text-brand hover:bg-line disabled:opacity-40"
            >
              모두 읽음
            </button>
          ) : undefined
        }
      />
      <div className="mx-auto max-w-[760px] space-y-3">
        <p className="px-1 text-[14px] text-sub">
          리포트 완성·모의 자동매매 단계·오늘의 내 종목 뉴스 알림이 쌓여요. 안 읽은 알림 <b className="text-ink tabular-nums">{unread}</b>개. Discord로도 받으려면{" "}
          <Link to="/my" className="font-semibold text-brand underline">
            마이 &gt; 알림 설정
          </Link>
          .
        </p>
        {isPending ? (
          <SkeletonCard lines={5} />
        ) : isError ? (
          <Card>
            <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
          </Card>
        ) : list.length === 0 ? (
          <Card>
            <EmptyState>아직 알림이 없습니다.</EmptyState>
          </Card>
        ) : (
          <ul aria-label="알림 목록" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
            {list.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => openItem(n)}
                  aria-label={`${n.readAt ? "" : "안 읽음: "}${n.title}`}
                  className={cn("flex w-full items-start gap-3 px-5 py-4 text-left hover:bg-fill/60", !n.readAt && "bg-brand-soft/40")}
                >
                  <span
                    className={cn(
                      "grid size-9 shrink-0 place-items-center rounded-full",
                      n.readAt ? "bg-fill text-mute" : "bg-brand text-white",
                    )}
                  >
                    <Icon name={KIND_ICON[n.kind] ?? "bell"} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-semibold text-mute">{notificationKindText(n.kind)}</span>
                    <span className="flex items-center gap-1.5">
                      <span className={cn("truncate text-[15px]", n.readAt ? "font-medium text-sub" : "font-bold text-ink")}>{n.title}</span>
                      {!n.readAt && (
                        <span className="shrink-0 rounded bg-up px-1 text-[11px] leading-[18px] font-bold text-white">새 알림</span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[14px] leading-snug text-sub">{n.body}</span>
                    <span className="mt-1 block text-[12px] text-mute">{formatRelative(n.createdAt)}</span>
                  </span>
                  {n.link && <Icon name="chevron" className="mt-2 size-4 shrink-0 text-mute" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
