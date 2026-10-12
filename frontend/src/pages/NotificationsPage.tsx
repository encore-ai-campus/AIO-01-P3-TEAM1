// /notifications: 내 알림 (최신순, 안 읽은 것 강조). 매번 목록을 보러 오는 화면이라 목록이 맨 위다 (설명은 빈 화면에만).
// 링크가 있는 알림은 링크(누르면 읽음 처리 + 그 화면, 새 탭에서 열기도 된다), 없으면 읽음 처리 버튼. 머리에 '모두 읽음'(안 읽은 게 있을 때)·알림 설정 톱니.
// 갈 곳은 홈 최근 알림과 같은 규칙(lib/nav.ts notificationHref): 오늘의 내 종목 뉴스는 홈의 그 카드로 내려간다.
// 읽음은 화면에 먼저 반영한다(api/autotrade.ts useMarkRead): 목록·종 배지·홈 최근 알림이 같은 순간에 바뀌고, 실패하면 되돌린 뒤 오류를 알린다.
// 알림마다 종류 이름(lib/plainText.ts NOTIFICATION_KIND_TEXT)을 보인다. 문장은 서버가 받는 사람의 주린이모드에 맞춰 만든다.
// PC(lg 이상): 목록은 날짜 묶음(오늘·어제·이번 주·이전) + 목록 카드 머리 줄[종류 칩(종류가 둘 이상일 때) | '모두 읽음'], 알림 설정 카드(마이와 같은 카드)가 같은 화면에 있다.
// xl(1280px)부터 두 칸 [목록 | 360px 알림 설정], 1024~1279px은 한 칸(목록 → 아래 알림 설정 — 두 칸이면 목록이 376px로 좁아 제목이 잘린다, B0-10).
// 설정이 같은 화면에 있으니 PC 머리에는 톱니가 없고, '모두 읽음'은 목록에 대한 동작이라 목록 카드 머리에 둔다(PC). 사라지면 포커스는 알림 설정 제목으로 간다.
// 빈 화면 문장은 Discord를 쓸 수 있을 때(webhookConfigured)만 Discord를 말한다 — 준비 중인 기능을 켜라고 하지 않는다.
// 모바일은 그대로(한 목록 + 머리의 톱니). PC 묶음·칩·설정 칸은 화면 폭으로 고른다(matchMedia) — 모바일 DOM에 숨은 사본을 두지 않는다.
import { type ReactNode, useRef, useState } from "react";
import { Link } from "react-router";
import { useMarkRead } from "../api/autotrade";
import { errorMessage } from "../api/client";
import { useNotificationSettings, useNotifications } from "../api/queries";
import type { Notification } from "../api/types";
import { Icon, type IconName } from "../components/Icon";
import { useToast } from "../components/toast";
import { NotificationSettingsCard } from "../components/autotrade/NotificationSettingsCard";
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from "../components/ui";
import { useNewKeys, revealList, useRevealAfterLoading } from "../hooks/useMotionState";
import { useIsPc } from "../hooks/useIsPc";
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

/** PC 종류 칩. 종류 이름은 알림 줄의 이름(NOTIFICATION_KIND_TEXT)을 묶은 것이다. 모르는 종류·시스템 알림은 '전체'에만. */
const FILTERS = [
  { value: "all", label: "전체", kinds: null },
  {
    value: "trade",
    label: "계획·주문",
    kinds: ["recommendation", "plan_activated", "order_placed", "order_requeued", "filled", "closed", "cancelled", "expired", "failed"],
  },
  { value: "report", label: "리포트", kinds: ["report_completed", "report_failed"] },
  { value: "stock", label: "내 종목 소식", kinds: ["daily_move", "thesis_check"] },
] as const;
type Filter = (typeof FILTERS)[number]["value"];
const inFilter = (n: Notification, f: (typeof FILTERS)[number]) => f.kinds === null || (f.kinds as readonly string[]).includes(n.kind);

/** 날짜 묶음: 오늘 · 어제 · 이번 주(7일 안) · 이전. 이 기기의 날짜로 센다. */
const GROUPS = ["오늘", "어제", "이번 주", "이전"] as const;
function groupOf(iso: string, now: Date): (typeof GROUPS)[number] {
  const t = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(t)) / 86_400_000);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 7) return "이번 주";
  return "이전";
}

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

/**
 * 알림 한 줄의 내용. 이름은 '안 읽음: 제목'(labelledby), 종류·본문·시각은 설명(describedby)으로 읽힌다.
 * PC(lg)는 줄이 격자다: [아이콘 | 종류·제목·본문 | 시각(오른쪽 위) | 화살표] — 가운데 묶음은 contents라 순서는 모바일과 같다.
 */
function Body({ n, id }: { n: Notification; id: string }) {
  const unread = !n.readAt;
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full transition-colors lg:row-span-3",
          unread ? "bg-brand text-white" : "bg-fill text-mute-weak",
        )}
      >
        <Icon name={KIND_ICON[n.kind] ?? "bell"} className="size-4" />
      </span>
      <span className="min-w-0 flex-1 lg:contents">
        <span id={`${id}-kind`} className="block text-[12px] font-semibold text-mute lg:col-start-2 lg:row-start-1 lg:text-[13px]">
          {notificationKindText(n.kind)}
        </span>
        <span className="flex items-center gap-1.5 lg:col-start-2 lg:row-start-2 lg:min-w-0">
          {unread && (
            <span id={`${id}-state`} className="sr-only">
              안 읽음:
            </span>
          )}
          <span
            id={`${id}-title`}
            className={cn("truncate text-[15px] transition-colors lg:text-[16px]", unread ? "font-bold text-ink" : "font-medium text-sub")}
          >
            {n.title}
          </span>
          {unread && (
            // 흰 글자 on 빨강(11px)은 대비가 모자라 연한 바탕 + 진한 글자로 (두 테마 AA). 화면 읽기는 제목 앞 '안 읽음:'으로 듣는다
            <span aria-hidden="true" className="shrink-0 rounded bg-up-soft px-1 text-[11px] leading-[18px] font-bold text-up-ink">
              안 읽음
            </span>
          )}
        </span>
        <span id={`${id}-body`} className="mt-0.5 block text-[14px] leading-snug text-sub lg:col-start-2 lg:row-start-3 lg:text-[15px]">
          {n.body}
        </span>
        <span
          id={`${id}-time`}
          className="mt-1 block text-[12px] text-mute lg:col-start-3 lg:row-start-1 lg:mt-0 lg:text-right lg:text-[13px] lg:whitespace-nowrap lg:tabular-nums"
        >
          {formatRelative(n.createdAt)}
        </span>
      </span>
      {n.link && <Icon name="chevron" className="mt-2 size-4 shrink-0 text-mute-weak lg:col-start-4 lg:row-span-3 lg:row-start-1 lg:mt-0 lg:self-center" />}
    </>
  );
}

function Row({ n, fresh, onRead, grouped = false }: { n: Notification; fresh: boolean; onRead: (n: Notification) => void; grouped?: boolean }) {
  const id = `noti-${n.id}`;
  const unread = !n.readAt;
  // 이 화면에서 읽은 링크 없는 알림은 버튼을 그대로 둔다: div로 바꾸면 누른 버튼의 포커스가 body로 떨어지고 색 전이도 끊긴다
  const [startedUnread] = useState(unread);
  const label = {
    "aria-labelledby": unread ? `${id}-state ${id}-title` : `${id}-title`,
    "aria-describedby": `${id}-kind ${id}-body ${id}-time`,
  };
  const rowClass = cn(
    "flex w-full items-start gap-3 px-5 py-4 text-left",
    "lg:grid lg:grid-cols-[2.25rem_minmax(0,1fr)_auto_1rem] lg:gap-x-4 lg:gap-y-0.5 lg:px-6",
    unread && "bg-brand-soft/40",
  );
  // 누르는 행의 키보드 포커스 테두리는 안쪽에 그린다: 목록 카드(ul)가 overflow-hidden rounded-2xl이라 바깥 테두리는 잘려
  // 선 하나만 남거나 이웃 행의 테두리처럼 보인다 (a11y-5). 카드의 첫 행·마지막 행은 테두리 모서리를 카드와 맞춘다
  // (PC 날짜 묶음은 묶음마다 목록이 나뉘어 카드 가운데에서 끝나므로 모서리를 두지 않는다)
  const pressable = cn(
    "press-row hover:bg-fill/60 focus-visible:outline-offset-[-2px]",
    !grouped && "[li:first-child>&]:rounded-t-2xl [li:last-child>&]:rounded-b-2xl",
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

/** 알림이 있는 종류 칩의 수 ('전체' 빼고). 하나뿐이면 칩 줄은 아무것도 거르지 않으니 두지 않는다. */
const kindsIn = (list: Notification[]) => FILTERS.filter((f) => f.value !== "all" && list.some((n) => inFilter(n, f))).length;

/** PC 종류 칩: 고른 칩은 aria-pressed. 알림이 없는 종류는 칩을 두지 않는다 ('전체'는 늘 있다). */
function KindFilter({ list, value, onChange }: { list: Notification[]; value: Filter; onChange: (f: Filter) => void }) {
  return (
    <div role="group" aria-label="알림 종류" className="flex min-w-0 flex-wrap gap-2">
      {FILTERS.map((f) => {
        const count = list.filter((n) => inFilter(n, f)).length;
        if (f.value !== "all" && count === 0) return null;
        const on = value === f.value;
        return (
          <button
            key={f.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(f.value)}
            className={cn(
              "press inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold transition-colors duration-fast",
              on
                ? "bg-ink text-on-ink forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText] forced-colors:forced-color-adjust-none"
                : "bg-fill text-sub hover:bg-line",
            )}
          >
            {f.label}
            <span className={cn("tabular-nums", on ? "text-on-ink/70" : "text-mute")}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** PC 목록: 머리 줄(칩 · '모두 읽음') → 날짜 묶음(제목 + 목록). 칩으로 고른 종류가 비면 '전체 보기'로 돌아가는 길. */
function GroupedList({
  list,
  fresh,
  reveal,
  onRead,
  unread,
  onReadAll,
}: {
  list: Notification[];
  fresh: ReadonlySet<number>;
  reveal: boolean;
  onRead: (n: Notification) => void;
  unread: number;
  onReadAll: () => void;
}) {
  const [picked, setFilter] = useState<Filter>("all");
  const chips = kindsIn(list) >= 2;
  const filter = chips ? picked : "all"; // 칩 줄이 없으면 늘 전체
  const current = FILTERS.find((f) => f.value === filter) ?? FILTERS[0];
  const shown = list.filter((n) => inFilter(n, current));
  const now = new Date();
  const by = new Map<string, Notification[]>();
  for (const n of shown) {
    const g = groupOf(n.createdAt, now);
    by.set(g, [...(by.get(g) ?? []), n]);
  }
  const groups = GROUPS.filter((g) => by.has(g)).map((g) => ({ name: g, items: by.get(g)! }));
  return (
    <div className="overflow-hidden rounded-2xl bg-card">
      {(chips || unread > 0) && (
        <div className="flex min-h-11 items-center gap-3 px-6 pt-4 pb-3">
          {chips ? (
            <KindFilter list={list} value={filter} onChange={setFilter} />
          ) : (
            // 거를 종류가 하나뿐이면 칩 대신 남은 할 일(안 읽은 수)을 한 줄로
            <p className="text-[14px] text-sub">
              안 읽은 알림 <b className="text-ink tabular-nums">{unread}</b>개
            </p>
          )}
          <div className="ml-auto">
            <ReadAllButton show={unread > 0} onClick={onReadAll} />
          </div>
        </div>
      )}
      {groups.length === 0 ? (
        <EmptyState compact title="이 종류의 알림은 없어요" action={{ label: "전체 보기", onClick: () => setFilter("all") }}>
          다른 종류를 고르거나 전체 알림을 보세요.
        </EmptyState>
      ) : (
        groups.map((g, gi) => (
          <section key={g.name} aria-labelledby={`noti-group-${gi}`} className="pb-1">
            <h2
              id={`noti-group-${gi}`}
              className={cn("px-6 pt-4 pb-1.5 text-[13px] font-semibold text-mute", (gi > 0 || chips || unread > 0) && "border-t border-line")}
            >
              {g.name}
            </h2>
            <ul aria-label={`${g.name} 알림`} {...revealList(reveal)} className="divide-y divide-line">
              {g.items.map((n) => (
                <Row key={n.id} n={n} fresh={fresh.has(n.id)} onRead={onRead} grouped />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

export function NotificationsPage() {
  const { data, isPending, isError, error, refetch, isFetching } = useNotifications(false);
  const toast = useToast();
  const read = useMarkRead((err) => toast(errorMessage(err), "error"));
  const pc = useIsPc();
  const settings = useRef<HTMLAnchorElement>(null);
  // Discord를 쓸 수 있을 때만 빈 화면에서 Discord를 말한다 (모르는 동안은 말하지 않는다 — 마이·오른쪽 카드와 같은 캐시)
  const discordReady = useNotificationSettings().data?.webhookConfigured === true;
  const reveal = useRevealAfterLoading(isPending);
  const list = data?.results ?? [];
  const unread = data?.unreadCount ?? 0;
  // 폴링으로 새로 온 알림만 움직인다 (처음 그림은 그대로)
  const fresh = useNewKeys(
    list.map((n) => n.id),
    !isPending,
  );
  const onRead = (x: Notification) => read.mutate({ ids: [x.id] });

  const readAll = () => {
    // 누른 버튼이 곧 사라지므로 포커스를 이웃한 알림 설정으로 먼저 옮긴다 (body로 떨어지지 않게).
    // PC는 같은 화면의 알림 설정 카드 제목(이름 있는 h2, tabIndex -1). 카드가 아직 없으면(불러오는 중·오류) 화면 제목 h1로
    const target = pc ? (document.getElementById("noti-settings-title") ?? document.querySelector<HTMLElement>("main h1")) : settings.current;
    target?.focus({ preventScroll: true });
    read.mutate({ all: true }, { onSuccess: () => toast("알림을 모두 읽었어요.", "success") });
  };

  const body = isPending ? (
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
        // PC는 위 바에 '리포트 만들기'(주 버튼)가 늘 있어 여기서는 보조 모양으로 (주 행동이 둘로 나뉘지 않게). 알림 설정은 같은 화면에 있다
        action={pc ? undefined : { label: "AI 리포트 만들기", to: "/reports" }}
        secondary={pc ? { label: "AI 리포트 만들기", to: "/reports" } : { label: "알림 설정", to: "/my#notification-settings" }}
      >
        <span className="lg:mx-auto lg:block lg:max-w-[44ch]">
          리포트 완성·모의 자동매매 단계·오늘의 내 종목 뉴스가 여기 쌓여요.
          {discordReady && " Discord로도 받으려면 알림 설정에서 켜요."}
        </span>
      </EmptyState>
    </Card>
  ) : pc ? (
    <GroupedList list={list} fresh={fresh} reveal={reveal} onRead={onRead} unread={unread} onReadAll={readAll} />
  ) : (
    <ul aria-label="알림 목록" {...revealList(reveal)} className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
      {list.map((n) => (
        <Row key={n.id} n={n} fresh={fresh.has(n.id)} onRead={onRead} />
      ))}
    </ul>
  );

  return (
    <>
      <PageHeader
        title="알림"
        back
        pcBack={false}
        right={
          <>
            {/* PC는 목록 카드 머리에 둔다 (목록이 있을 때만 — 없으면 읽을 것도 없다) */}
            {!pc && <ReadAllButton show={unread > 0} onClick={readAll} />}
            {!pc && (
              <Link
                ref={settings}
                to="/my#notification-settings"
                aria-label="알림 설정"
                className="grid size-11 shrink-0 place-items-center rounded-full text-ink transition-colors hover:bg-line/60 active:bg-line/60"
              >
                <Icon name="settings" className="size-[22px]" />
              </Link>
            )}
          </>
        }
      />
      {pc ? (
        // PC: xl부터 [목록 | 오른쪽 360px 알림 설정(붙는다)], 1024~1279px은 한 칸(목록 → 알림 설정)
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">{body}</div>
          <div className="min-w-0 xl:sticky xl:top-(--rail-top)">
            <NotificationSettingsCard />
          </div>
        </div>
      ) : (
        body
      )}
    </>
  );
}
