// 쉬운 보기 홈의 "최근 알림" 3개. 알림 화면과 같은 방식이다: 줄마다 갈 곳으로 가는 링크(새 탭에서 열기도 된다)이고, 누르면 읽음 처리한다.
// 갈 곳은 lib/nav.ts notificationHref — 오늘의 내 종목 뉴스는 홈의 그 카드로 내려가고(같은 주소라 아무 일도 없어 보이지 않게), 링크가 없는 알림은 알림 화면으로.
// 읽음은 화면에 먼저 반영한다(useMarkRead): 이 목록·종 배지·알림 화면이 같은 순간에 바뀌고, 실패하면 되돌린 뒤 오류를 알린다.
// 이름은 '안 읽음: 제목'(labelledby), 종류·시각은 설명(describedby). 안 읽음 표시는 연한 빨강 바탕 + 진한 글자 배지 (흰 글자 on 빨강은 대비가 모자랐다).
import { Link } from "react-router";
import { useMarkRead } from "../../api/autotrade";
import { errorMessage } from "../../api/client";
import { useNotifications } from "../../api/queries";
import type { Notification } from "../../api/types";
import { revealList, useRevealAfterLoading } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/format";
import { notificationHref } from "../../lib/nav";
import { notificationKindText } from "../../lib/plainText";
import { useToast } from "../toast";
import { useShownCount } from "./homeHooks";
import { EmptyRow, HOME_ROW_BASE, RowsSkeleton, SectionError } from "./HomeStates";
import { SectionHead } from "./SectionHead";

function Row({ n, onRead }: { n: Notification; onRead: (n: Notification) => void }) {
  const id = `home-noti-${n.id}`;
  const unread = !n.readAt;
  return (
    <Link
      to={notificationHref(n)}
      aria-labelledby={unread ? `${id}-state ${id}-title` : `${id}-title`}
      aria-describedby={`${id}-kind ${id}-time`}
      onClick={() => unread && onRead(n)}
      className={cn(HOME_ROW_BASE, "block", unread && "bg-brand-soft/40")}
    >
      <span className="flex items-center gap-1.5 text-[12px] font-semibold text-mute">
        <span id={`${id}-kind`}>{notificationKindText(n.kind)}</span>
        <span id={`${id}-time`} className="ml-auto font-normal">
          {formatRelative(n.createdAt)}
        </span>
      </span>
      <span className="mt-0.5 flex items-center gap-1.5">
        {unread && (
          <span id={`${id}-state`} className="sr-only">
            안 읽음:
          </span>
        )}
        <span id={`${id}-title`} className={cn("min-w-0 truncate text-[15px]", unread ? "font-bold text-ink" : "font-medium text-sub")}>
          {n.title}
        </span>
        {unread && (
          // 알림 화면과 같은 표시. 화면 읽기는 제목 앞 '안 읽음:'으로 듣는다
          <span aria-hidden="true" className="shrink-0 rounded bg-up-soft px-1 text-[11px] leading-[18px] font-bold text-up-ink">
            안 읽음
          </span>
        )}
      </span>
    </Link>
  );
}

export function RecentNotifications() {
  const { data, isPending, isFetching, refetch } = useNotifications(false);
  const reveal = useRevealAfterLoading(isPending);
  const toast = useToast();
  const read = useMarkRead((err) => toast(errorMessage(err), "error"));
  const list = (data?.results ?? []).slice(0, 3);
  // 받기 전 자리: 지난번에 본 행 수만큼 (기억이 없으면 3줄)
  const rows = useShownCount("noti", data ? list.length : undefined, 3);
  return (
    <section aria-labelledby="home-noti-title" className="space-y-3">
      <SectionHead id="home-noti-title" title="최근 알림" to="/notifications" />
      {isPending ? (
        <RowsSkeleton rows={rows} shape="noti" />
      ) : !data ? (
        <SectionError onRetry={() => void refetch()} retrying={isFetching} />
      ) : list.length === 0 ? (
        <EmptyRow icon="bell" className={reveal ? "reveal-fade" : undefined}>
          아직 알림이 없어요. 리포트가 완성되거나 모의 자동매매가 움직이면 여기에 보여요.
        </EmptyRow>
      ) : (
        <ul {...revealList(reveal)} aria-label="최근 알림 목록" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {list.map((n) => (
            <li key={n.id}>
              <Row n={n} onRead={(x) => read.mutate({ ids: [x.id] })} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
