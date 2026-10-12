// 마이의 '내 성적' 카드: 내 수익률(장마감 기준) → 투자금액·총자산 → 일별 자산 추이 → 랭킹 상위 3 → 내 정보 공개 스위치.
// 랭킹이 하단 탭에서 빠져서 마이를 여는 잦은 이유가 '내 순위·수익률'이다: 순위는 수익률 머리 줄에 붙여 첫 화면에 들어오게 하고,
// 랭킹에 나오게 하는 스위치(내 정보 공개)는 랭킹 바로 아래에 둔다 (원인과 해결을 붙여 둔다).
// 현금·보유 평가액·초기 자금은 홈 '내 자산'·모의투자 탭과 겹쳐서 빼고 '자산 자세히'로 보낸다 (투자금액은 1차 범위라 남긴다).
import { useState } from "react";
import { Link } from "react-router";
import { errorMessage } from "../../api/client";
import { useUpdateProfile } from "../../api/profile";
import { useAccount, useEquity, useRanking } from "../../api/queries";
import type { Me } from "../../api/types";
import { useViewMode } from "../../hooks/useBeginnerMode";
import { markShown, useNewKeys, useRevealAfterLoading } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { formatKrw, formatRate, formatSignedKrw, trendClass } from "../../lib/format";
import { PricesAsOfLine } from "../AssetCard";
import { Icon } from "../Icon";
import { LineChart } from "../charts/LineChart";
import { useToast } from "../toast";
import { ErrorState, Flash, Medal, RateText, Skeleton, Switch } from "../ui";

/** 불러오는 동안의 자리: 실제 카드와 같은 순서·비슷한 높이 (도착할 때 아래 카드가 덜 밀리게). */
function PerformanceSkeleton() {
  return (
    <div role="group" aria-busy="true" aria-label="불러오는 중" className="space-y-3 rounded-2xl bg-card p-5">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-9 w-40" />
      <Skeleton className="h-4 w-28" />
      <div className="grid grid-cols-2 gap-3 pt-1">
        <Skeleton className="h-[68px] rounded-xl" />
        <Skeleton className="h-[68px] rounded-xl" />
      </div>
      <Skeleton className="h-52 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/** 수익률 옆 '랭킹 N위' (공개했을 때만). 누르면 전체 순위. 보이는 칩은 36px, 누르는 자리는 위아래 4px씩 넓혀 44px. */
function RankChip() {
  const { data } = useRanking();
  const rank = data?.me.isPublic ? data.me.rank : null;
  if (rank == null) return null;
  return (
    <Link
      to="/ranking"
      className="press relative -my-1 inline-flex h-9 shrink-0 items-center gap-1 rounded-full bg-fill pr-2 pl-3 text-[14px] font-semibold text-sub before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-line"
    >
      <Icon name="trophy" className="size-4 text-mute-weak" />
      랭킹 <b className="font-bold text-ink tabular-nums">{rank}위</b>
      <Icon name="chevron" className="size-4 text-mute-weak" />
    </Link>
  );
}

/** 내 정보 공개 (랭킹에 닉네임·수익률이 나온다). 누르자마자 바뀐 상태를 보이고, 실패하면 서버 값으로 돌아간다 (다시 그리지 않아 포커스가 남는다). */
function PublicToggle({ me }: { me: Me }) {
  const toast = useToast();
  const profile = useUpdateProfile();
  const [pending, setPending] = useState<boolean | null>(null);
  const checked = pending ?? me.isPublic;
  return (
    <div>
      <Switch
        checked={checked}
        busy={profile.isPending}
        describedBy="public-help"
        className="min-h-11"
        label={<span className="text-[16px] font-semibold">내 정보 공개</span>}
        onChange={(isPublic) => {
          if (profile.isPending) return; // 저장 중에는 막지 않고(포커스 유지) 누름만 무시한다
          setPending(isPublic);
          profile.mutate(
            { isPublic },
            {
              onSuccess: (m) => {
                setPending(null);
                toast(m.isPublic ? "랭킹에 내 수익률을 공개했어요." : "랭킹에서 내 수익률을 숨겼어요.", "success");
              },
              onError: (err) => {
                setPending(null);
                toast(errorMessage(err), "error");
              },
            },
          );
        }}
      />
      <p id="public-help" className="mt-0.5 text-[13px] leading-relaxed text-sub">
        켜면 랭킹에 닉네임과 수익률이 나와요. 금액·보유 종목은 공개되지 않아요.
      </p>
    </div>
  );
}

function RankingSection({ me, publicId, publicLit }: { me: Me; publicId?: string; publicLit: boolean }) {
  const { data, isPending, isError, isFetching, refetch } = useRanking();
  const reveal = useRevealAfterLoading(isPending);
  const top = data?.results.slice(0, 3) ?? [];
  // 공개를 켜거나 순위가 바뀌어 상위 3에 새로 들어온 줄만 움직인다 (첫 그림·폴링 갱신은 그대로)
  const fresh = useNewKeys(
    top.map((e) => e.nickname),
    !isPending,
  );
  return (
    <section aria-labelledby="my-rank-title" className="border-t border-line px-5 pt-3 pb-4">
      <Link to="/ranking" className="press-row -mx-2 flex min-h-11 items-center justify-between rounded-xl px-2 hover:bg-fill/60">
        <h2 id="my-rank-title" className="flex items-center gap-1.5 text-[17px] font-bold">
          <Icon name="trophy" className="size-5 text-mute-weak" />
          랭킹
        </h2>
        <span className="flex items-center gap-0.5 text-[14px] font-semibold text-mute">
          전체 순위
          <Icon name="chevron" className="size-4" />
        </span>
      </Link>
      {isPending ? (
        <Skeleton className="mt-2 h-24 w-full" />
      ) : isError ? (
        <div className="mt-2">
          <ErrorState compact message="순위를 불러오지 못했어요." onRetry={() => void refetch()} retrying={isFetching} />
        </div>
      ) : (
        <div className={reveal ? "reveal-fade" : undefined}>
          {top.length > 0 ? (
            <ol aria-label="랭킹 상위 3명" className="mt-2 space-y-1">
              {top.map((e) => (
                <li
                  key={e.nickname}
                  aria-current={e.isMe ? "true" : undefined}
                  className={cn("flex items-center gap-2.5 rounded-lg px-1.5 py-1", e.isMe && "bg-brand-soft", fresh.has(e.nickname) && "is-new")}
                  onAnimationEnd={fresh.has(e.nickname) ? markShown : undefined} // 순서가 바뀌어 줄이 옮겨져도 다시 올라오지 않게
                >
                  <Medal rank={e.rank} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
                    {e.nickname}
                    {e.isMe && <span className="ml-1.5 rounded-md bg-brand px-1.5 py-0.5 align-middle text-[11px] font-bold text-white">나</span>}
                  </span>
                  <Flash value={e.profitRate}>
                    <RateText rate={e.profitRate} className="text-[14px] font-semibold" />
                  </Flash>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-[14px] text-sub">아직 수익률을 공개한 팀원이 없어요.</p>
          )}
          {!data.me.isPublic && <p className="mt-2 text-[14px] text-sub">아래 &lsquo;내 정보 공개&rsquo;를 켜면 랭킹에 나와요.</p>}
        </div>
      )}
      <div className="mt-3 border-t border-line pt-2">
        {/* 해시로 가리켜 오면(/my#public) 이 자리로 포커스가 온다 (MyPage) — 다음 Tab이 바로 스위치. 표시는 물든 바탕이 한다 */}
        <div
          id={publicId}
          tabIndex={publicId ? -1 : undefined}
          className={cn("-mx-2 scroll-mt-16 rounded-xl px-2 py-1.5 outline-none transition-colors duration-slow", publicLit && "bg-brand-soft/60")}
        >
          <PublicToggle me={me} />
        </div>
      </div>
    </section>
  );
}

/**
 * 내 성적 카드. publicId: 다른 화면의 '공개 설정'(/my#public)이 가리키는 자리 — 위 카드가 다 그려진 뒤에만 붙인다 (MyPage).
 * 계좌를 받지 못하면 '내 수익률' 자리에만 오류를 보인다: 랭킹·'내 정보 공개'는 계좌와 상관없이 쓸 수 있어야 한다
 * (/my#public 링크가 가리킬 자리도 남는다). 다시 받기(10초 폴링)가 실패하면 마지막 값을 그대로 둔다 (홈 '내 자산'과 같다).
 */
export function PerformanceCard({ me, publicId, publicLit = false }: { me: Me; publicId?: string; publicLit?: boolean }) {
  const { data: acc, isPending, error, refetch, isFetching } = useAccount();
  const equity = useEquity(30);
  const { easy } = useViewMode();
  const reveal = useRevealAfterLoading(isPending);
  const drawChart = useRevealAfterLoading(equity.isPending);
  if (isPending) return <PerformanceSkeleton />;
  return (
    <div className={cn("rounded-2xl bg-card", reveal && "reveal-fade")}>
      <section aria-labelledby="my-account-title" className="px-5 pt-5 pb-4">
        <div className="flex min-h-9 items-center justify-between gap-3">
          <h2 id="my-account-title" className="text-[15px] font-semibold text-sub">
            내 수익률
          </h2>
          <RankChip />
        </div>
        {acc ? (
          <>
            <p className={cn("mt-1 text-[32px] leading-tight font-bold tracking-tight", trendClass(acc.profitRate))}>
              <Flash value={acc.profitRate}>
                <span className="tabular-nums">{formatRate(acc.profitRate)}</span>
              </Flash>
            </p>
            <p className={cn("text-[15px] font-semibold tabular-nums", trendClass(acc.profitKrw))}>{formatSignedKrw(acc.profitKrw)}</p>
            <PricesAsOfLine pricesAsOf={acc.pricesAsOf} className="mt-1" />
            <dl className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-fill p-3">
                <dt className="text-[13px] text-sub">투자금액</dt>
                <dd className="mt-0.5 text-[17px] font-bold tabular-nums">
                  <Flash value={acc.investedKrw}>{formatKrw(acc.investedKrw)}</Flash>
                </dd>
                {easy && <dd className="mt-0.5 text-[12px] leading-snug text-mute">지금 주식에 들어간 돈</dd>}
              </div>
              <div className="rounded-xl bg-fill p-3">
                <dt className="text-[13px] text-sub">총자산</dt>
                <dd className="mt-0.5 text-[17px] font-bold tabular-nums">
                  <Flash value={acc.equityKrw}>{formatKrw(acc.equityKrw)}</Flash>
                </dd>
                {easy && <dd className="mt-0.5 text-[12px] leading-snug text-mute">현금과 주식을 합친 돈</dd>}
              </div>
            </dl>
            <Link
              to="/portfolio"
              className="press-row -mx-2 mt-1 flex min-h-11 items-center justify-end gap-0.5 rounded-xl px-2 text-[14px] font-semibold text-mute hover:bg-fill/60"
            >
              현금·보유 종목 자세히
              <Icon name="chevron" className="size-4" />
            </Link>
          </>
        ) : (
          <div className="mt-2 mb-3">
            <ErrorState compact message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />
          </div>
        )}
        <div className="mt-1 border-t border-line pt-4">
          <h3 className="mb-2 text-[15px] font-semibold text-sub">일별 자산 추이 (30일 · 장마감 기준)</h3>
          {equity.data ? (
            <LineChart points={equity.data.points.map((p) => ({ day: p.day, value: p.equityKrw }))} label="일별 자산 추이" animate={drawChart} />
          ) : equity.isError ? (
            <ErrorState compact message={errorMessage(equity.error)} onRetry={() => void equity.refetch()} retrying={equity.isFetching} />
          ) : (
            <Skeleton className="h-52 w-full" />
          )}
        </div>
      </section>
      <RankingSection me={me} publicId={publicId} publicLit={publicLit} />
    </div>
  );
}
