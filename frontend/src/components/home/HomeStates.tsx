// 홈 섹션의 작은 상태 조각: 한 줄 오류 · 한 줄 빈 안내 · 목록 모양 스켈레톤 · 목록 행 클래스.
// 홈은 섹션이 많아서 빈·오류 상태를 한 줄로 줄여 자리를 덜 쓰고, 불러오는 동안의 자리는 실제 행 높이로 지난번에 본 행 수만큼 잡는다 (첫 화면이 밀리지 않게).
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { Icon, type IconName } from "../Icon";
import { Skeleton, Spinner } from "../ui";

/**
 * 카드 안 목록 행 (링크·버튼). 누르면 배경만 바뀌고(press-row), 키보드 포커스 테두리는 안쪽에 그린다 —
 * 행을 감싼 목록이 overflow-hidden rounded라 바깥 테두리는 잘린다. 첫·마지막 행은 모서리를 목록과 맞춘다.
 */
const HOME_ROW_CORE = "press-row w-full px-5 py-3.5 text-left hover:bg-fill/50 focus-visible:outline-offset-[-2px] [li:first-child>&]:rounded-t-2xl";

export const HOME_ROW_BASE = `${HOME_ROW_CORE} [li:last-child>&]:rounded-b-2xl`;

/** 아이콘·글자·› 가 한 줄로 놓이는 보통 행. 두 줄을 위아래로 쌓는 행(알림)은 HOME_ROW_BASE + block. */
export const HOME_ROW = `${HOME_ROW_BASE} flex items-center gap-3`;

/** 목록 아래에 같은 카드 안 다른 줄(안내 문구 등)이 이어질 때의 행: 마지막 행도 아래 모서리를 둥글리지 않는다 (누름·포커스 모양이 카드 가운데서 둥글어지지 않게). */
export const HOME_ROW_ABOVE = `${HOME_ROW_CORE} flex items-center gap-3`;

/** 행 오른쪽 끝 › (장식). */
export function RowChevron() {
  return <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />;
}

/**
 * 섹션 안 한 줄 오류: '불러오지 못했어요' + 다시 시도 (44px). 알림(role=alert)은 두지 않는다 —
 * 서버가 내려가면 홈 섹션 여럿이 한꺼번에 실패하므로, 알림은 홈 맨 위에서 한 번만 한다 (HomePage FailedNotice — 하나만 실패해도 화면 읽기에는 알린다).
 * bare: 이미 카드 안이면 바탕·안쪽 여백 없이.
 */
export function SectionError({ onRetry, retrying = false, bare = false, className }: { onRetry: () => void; retrying?: boolean; bare?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3", !bare && "rounded-2xl bg-card py-3 pr-3 pl-5", className)}>
      <p className="flex min-w-0 items-center gap-2 text-[14px] leading-snug text-sub">
        <Icon name="alert-circle" className="size-4 shrink-0 text-warn" />
        불러오지 못했어요
      </p>
      <button
        type="button"
        onClick={() => {
          if (!retrying) onRetry();
        }}
        aria-disabled={retrying || undefined}
        aria-busy={retrying || undefined}
        className={cn(
          "press inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-fill px-4 text-[14px] font-semibold text-sub hover:bg-line",
          retrying && "cursor-progress",
        )}
      >
        {retrying && <Spinner />}
        다시 시도
      </button>
    </div>
  );
}

/**
 * 섹션 안 한 줄 빈 안내 (작은 아이콘 + 다음에 할 일 한 줄). to가 있으면 줄 전체가 그곳으로 가는 링크다.
 * 빈 섹션이 큰 자리를 차지하지 않게 한 줄로 둔다 — 같은 섹션의 목록 행과 같은 모양이라 자리도 그대로다.
 */
export function EmptyRow({ icon, children, to, className }: { icon: IconName; children: ReactNode; to?: string; className?: string }) {
  const body = (
    <>
      <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-fill text-mute-weak">
        <Icon name={icon} className="size-4" />
      </span>
      <span className="min-w-0 flex-1 text-[14px] leading-snug text-sub">{children}</span>
      {to && <RowChevron />}
    </>
  );
  return to ? (
    <Link to={to} className={cn("press-row flex items-center gap-3 rounded-2xl bg-card px-5 py-3.5 hover:bg-fill/50", className)}>
      {body}
    </Link>
  ) : (
    <p className={cn("flex items-center gap-3 rounded-2xl bg-card px-5 py-3.5", className)}>{body}</p>
  );
}

/**
 * 스켈레톤 한 줄: 실제 줄과 같은 글자 크기·줄 간격의 상자(h-lh = 한 줄 높이) 안에 막대 하나 — 글자 크기가 바뀌어도 높이가 같이 따라간다.
 * wideHidden: 목록이 넓으면(480px 이상) 앞 줄과 한 줄로 들어가 없는 줄 (좁은 화면에서만 두 줄로 꺾이는 가격 줄·요약).
 */
interface SkeletonLine {
  box: string;
  bar: string;
  wideHidden?: boolean;
}

/** 스켈레톤 행 모양을 고르는 이름 (섹션마다 하나). */
export type RowShape = "live" | "plan" | "rec" | "report" | "noti";

/**
 * 섹션마다 실제 행과 같은 모양 (390·1280px에서 잰 행 높이). 줄 상자의 클래스는 실제 행의 글자 클래스를 그대로 따른다.
 * - live: 쉬운 보기 진행 중 (LivePlans) 아이콘 + 이름·상태 / 한 줄 설명 / 수량·출처 — 92px
 * - plan: 전문가 보기 진행 중 (PlanRow) 이름 / 수량·진입가 / 출처·목표·손절 — 108px
 * - rec: 새 계획 제안 이름·배지 / 진입·목표·손절·남은 시간 — 좁으면 93px, 넓으면 74px
 * - report: 최근 AI 리포트 이름·AI 의견 배지 / 한 줄 요약 / 시각·만든 사람 — 좁으면 114px, 넓으면 94px
 * - noti: 최근 알림 종류·시각 / 제목 — 71px
 * - empty: 지난번에 비었던 섹션 — EmptyRow와 같은 한 줄 (아이콘 + 안내 두 줄) 67px
 */
const ROW_SHAPES: Record<RowShape | "empty", { pad: string; icon: boolean; lines: SkeletonLine[] }> = {
  live: {
    pad: "py-3.5",
    icon: true,
    lines: [
      { box: "h-lh text-[16px]", bar: "h-4 w-1/2" },
      { box: "mt-0.5 h-lh text-[13px] leading-snug", bar: "h-3 w-4/5" },
      { box: "mt-0.5 h-lh text-[12px]", bar: "h-3 w-1/3" },
    ],
  },
  plan: {
    pad: "py-4",
    icon: false,
    lines: [
      { box: "h-lh text-[16px]", bar: "h-4 w-2/5" },
      { box: "h-lh text-[13px]", bar: "h-3 w-1/2" },
      { box: "mt-2 h-6", bar: "h-4 w-3/5" },
    ],
  },
  rec: {
    pad: "py-3.5",
    icon: false,
    lines: [
      { box: "h-lh text-[16px]", bar: "h-4 w-2/5" },
      { box: "mt-0.5 h-lh text-[13px]", bar: "h-3 w-4/5" },
      { box: "h-lh text-[13px]", bar: "h-3 w-1/3", wideHidden: true },
    ],
  },
  report: {
    pad: "py-3.5",
    icon: false,
    lines: [
      // AI 의견 배지(24px)가 글자 기준선에 맞춰 놓여 이름 줄이 25px이다
      { box: "h-[25px]", bar: "h-4 w-1/2" },
      { box: "mt-0.5 h-lh text-[14px] leading-snug", bar: "h-3.5 w-11/12" },
      { box: "h-lh text-[14px] leading-snug", bar: "h-3.5 w-2/3", wideHidden: true },
      { box: "mt-0.5 h-lh text-[12px]", bar: "h-3 w-1/3" },
    ],
  },
  noti: {
    pad: "py-3.5",
    icon: false,
    lines: [
      { box: "h-lh text-[12px]", bar: "h-3 w-1/4" },
      { box: "mt-0.5 h-lh text-[15px]", bar: "h-4 w-3/5" },
    ],
  },
  empty: {
    pad: "py-3.5",
    icon: true,
    lines: [
      { box: "h-lh text-[14px] leading-snug", bar: "h-3.5 w-11/12" },
      { box: "h-lh text-[14px] leading-snug", bar: "h-3.5 w-1/2" },
    ],
  },
};

/**
 * 목록 모양 스켈레톤: 섹션의 실제 행과 같은 높이(shape)로 rows개 (지난번에 본 행 수 — homeHooks useShownCount).
 * rows가 0이면(지난번에 비었다) 빈 안내 한 줄 모양. 받은 뒤 아래 내용이 밀리지 않게 한다. role=status는 쓰지 않는다 (토스트가 쓴다).
 */
export function RowsSkeleton({ rows, shape, className }: { rows: number; shape: RowShape; className?: string }) {
  const s = rows > 0 ? ROW_SHAPES[shape] : ROW_SHAPES.empty;
  return (
    <div
      role="group"
      aria-busy="true"
      aria-label="불러오는 중"
      className={cn("divide-y divide-line overflow-hidden rounded-2xl bg-card @container", className)}
    >
      {Array.from({ length: Math.max(1, rows) }, (_, i) => (
        <div key={i} className={cn("flex items-center gap-3 px-5", s.pad)}>
          {/* 원 모양: 모서리를 주면 Skeleton이 기본 rounded-lg를 뺀다 */}
          {s.icon && <Skeleton className="size-9 shrink-0 rounded-full" />}
          <div className="min-w-0 flex-1">
            {s.lines.map((l, j) => (
              <div key={j} className={cn("flex items-center", l.box, l.wideHidden && "@min-[480px]:hidden")}>
                <Skeleton className={l.bar} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
