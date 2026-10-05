// /notifications: 내 알림 (최신순, 안 읽은 것 강조). 매번 목록을 보러 오는 화면이라 목록이 맨 위다 (설명은 빈 화면에만).
// 링크가 있는 알림은 링크(누르면 읽음 처리 + 그 화면, 새 탭에서 열기도 된다), 없으면 읽음 처리 버튼. 머리에 '모두 읽음'(안 읽은 게 있을 때)·알림 설정 톱니.
// 갈 곳은 홈 최근 알림과 같은 규칙(lib/nav.ts notificationHref): 오늘의 내 종목 뉴스는 홈의 그 카드로 내려간다.
// 읽음은 화면에 먼저 반영한다(api/autotrade.ts useMarkRead): 목록·종 배지·홈 최근 알림이 같은 순간에 바뀌고, 실패하면 되돌린 뒤 오류를 알린다.
// 알림마다 종류 이름(lib/plainText.ts NOTIFICATION_KIND_TEXT)을 보인다. 문장은 서버가 받는 사람의 주린이모드에 맞춰 만든다.
import { type ReactNode, useRef, useState } from "react";
import { Link } from "react-router";
import { useMarkRead } from "../api/autotrade";
import { errorMessage } from "../api/client";
import { useNotifications } from "../api/queries";
import type { Notification } from "../api/types";
import { Icon, type IconName } from "../components/Icon";
import { useToast } from "../components/toast";
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from "../components/ui";
import { useNewKeys, revealList, useRevealAfterLoading } from "../hooks/useMotionState";
import { usePresence } from "../hooks/usePresence";
import { cn } from "../lib/cn";
import { formatRelative } from "../lib/format";
import { notificationHref } from "../lib/nav";
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

/** '모두 읽음': 다 읽으면 사라진다 (짧게 흐려지며). 포커스는 이웃한 알림 설정으로 옮긴다. */
function ReadAllButton({ show, onClick }: { show: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { present, state } = usePresence(show, ref);
  if (!present) return null;
  return (
    <button
      ref={ref}
      type="button"
      inert={state === "closing"}
      onClick={onClick}
      className={cn(
        "press h-11 shrink-0 rounded-xl px-3 text-[15px] font-semibold text-brand-ink hover:bg-line/60",
        state === "closing" && "animate-fade-out",
      )}
    >
      모두 읽음
    </button>
  );
}

/** 알림 한 줄의 내용. 이름은 '안 읽음: 제목'(labelledby), 종류·본문·시각은 설명(describedby)으로 읽힌다. */
function Body({ n, id }: { n: Notification; id: string }) {
  const unread = !n.readAt;
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full transition-colors",
          unread ? "bg-brand text-white" : "bg-fill text-mute-weak",
        )}
      >
        <Icon name={KIND_ICON[n.kind] ?? "bell"} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span id={`${id}-kind`} className="block text-[12px] font-semibold text-mute">
          {notificationKindText(n.kind)}
        </span>
        <span className="flex items-center gap-1.5">
          {unread && (
            <span id={`${id}-state`} className="sr-only">
              안 읽음:
            </span>
          )}
          <span id={`${id}-title`} className={cn("truncate text-[15px] transition-colors", unread ? "font-bold text-ink" : "font-medium text-sub")}>
            {n.title}
          </span>
          {unread && (
            // 흰 글자 on 빨강(11px)은 대비가 모자라 연한 바탕 + 진한 글자로 (두 테마 AA). 화면 읽기는 제목 앞 '안 읽음:'으로 듣는다
            <span aria-hidden="true" className="shrink-0 rounded bg-up-soft px-1 text-[11px] leading-[18px] font-bold text-up-ink">
              안 읽음
            </span>
          )}
        </span>
        <span id={`${id}-body`} className="mt-0.5 block text-[14px] leading-snug text-sub">
          {n.body}
        </span>
        <span id={`${id}-time`} className="mt-1 block text-[12px] text-mute">
          {formatRelative(n.createdAt)}
        </span>
      </span>
      {n.link && <Icon name="chevron" className="mt-2 size-4 shrink-0 text-mute-weak" />}
    </>
  );
}

function Row({ n, fresh, onRead }: { n: Notification; fresh: boolean; onRead: (n: Notification) => void }) {
  const id = `noti-${n.id}`;
  const unread = !n.readAt;
  // 이 화면에서 읽은 링크 없는 알림은 버튼을 그대로 둔다: div로 바꾸면 누른 버튼의 포커스가 body로 떨어지고 색 전이도 끊긴다
  const [startedUnread] = useState(unread);
  const label = {
    "aria-labelledby": unread ? `${id}-state ${id}-title` : `${id}-title`,
    "aria-describedby": `${id}-kind ${id}-body ${id}-time`,
  };
  const rowClass = cn("flex w-full items-start gap-3 px-5 py-4 text-left", unread && "bg-brand-soft/40");
  // 누르는 행의 키보드 포커스 테두리는 안쪽에 그린다: 목록 카드(ul)가 overflow-hidden rounded-2xl이라 바깥 테두리는 잘려
  // 선 하나만 남거나 이웃 행의 테두리처럼 보인다 (a11y-5). 카드의 첫 행·마지막 행은 테두리 모서리를 카드와 맞춘다
  const pressable = cn(
    "press-row hover:bg-fill/60 focus-visible:outline-offset-[-2px] [li:first-child>&]:rounded-t-2xl [li:last-child>&]:rounded-b-2xl",
    rowClass,
  );
  let content: ReactNode;
  if (n.link) {
    content = (
      <Link to={notificationHref(n)} {...label} onClick={() => unread && onRead(n)} className={pressable}>
        <Body n={n} id={id} />
      </Link>
    );
  } else if (unread || startedUnread) {
    content = (
      <button type="button" {...label} onClick={() => unread && onRead(n)} className={pressable}>
        <Body n={n} id={id} />
      </button>
    );
  } else {
    // 처음부터 읽은 링크 없는 알림: 할 일이 없는 줄이라 버튼이 아니다. 일반 요소에는 aria 이름을 달지 않는다 (내용이 그대로 읽힌다)
    content = (
      <div className={rowClass}>
        <Body n={n} id={id} />
      </div>
    );
  }
  return <li className={fresh ? "is-new" : undefined}>{content}</li>;
}

export function NotificationsPage() {
  const { data, isPending, isError, error, refetch, isFetching } = useNotifications(false);
  const toast = useToast();
  const read = useMarkRead((err) => toast(errorMessage(err), "error"));
  const settings = useRef<HTMLAnchorElement>(null);
  const reveal = useRevealAfterLoading(isPending);
  const list = data?.results ?? [];
  const unread = data?.unreadCount ?? 0;
  // 폴링으로 새로 온 알림만 움직인다 (처음 그림은 그대로)
  const fresh = useNewKeys(
    list.map((n) => n.id),
    !isPending,
  );

  const readAll = () => {
    // 누른 버튼이 곧 사라지므로 포커스를 이웃한 알림 설정으로 먼저 옮긴다 (body로 떨어지지 않게)
    settings.current?.focus({ preventScroll: true });
    read.mutate({ all: true }, { onSuccess: () => toast("알림을 모두 읽었어요.", "success") });
  };

  return (
    // PC: 목록 화면 폭 규칙(랭킹과 같은 760px, 제목과 같은 왼쪽 선). 머리도 같은 폭이라 '모두 읽음'이 목록 오른쪽 끝과 맞는다
    <div className="lg:max-w-[760px]">
      <PageHeader
        title="알림"
        back
        right={
          <>
            <ReadAllButton show={unread > 0} onClick={readAll} />
            <Link
              ref={settings}
              to="/my#notification-settings"
              aria-label="알림 설정"
              className="grid size-11 shrink-0 place-items-center rounded-full text-ink transition-colors hover:bg-line/60 active:bg-line/60"
            >
              <Icon name="settings" className="size-[22px]" />
            </Link>
          </>
        }
      />
      {isPending ? (
        <div aria-busy="true" aria-label="불러오는 중" role="group" className="space-y-px overflow-hidden rounded-2xl bg-card">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3 px-5 py-4">
              {/* 동그라미 자리: 모서리를 주면 Skeleton이 기본 rounded-lg를 뺀다 */}
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <Card>
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />
        </Card>
      ) : list.length === 0 ? (
        <Card className={reveal ? "reveal-fade" : undefined}>
          <EmptyState
            icon="bell"
            title="아직 알림이 없어요"
            action={{ label: "AI 리포트 만들기", to: "/reports" }}
            secondary={{ label: "알림 설정", to: "/my#notification-settings" }}
          >
            리포트 완성·모의 자동매매 단계·오늘의 내 종목 뉴스가 여기 쌓여요. Discord로도 받으려면 알림 설정에서 켜요.
          </EmptyState>
        </Card>
      ) : (
        <ul aria-label="알림 목록" {...revealList(reveal)} className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {list.map((n) => (
            <Row key={n.id} n={n} fresh={fresh.has(n.id)} onRead={(x) => read.mutate({ ids: [x.id] })} />
          ))}
        </ul>
      )}
    </div>
  );
}

