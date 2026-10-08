// 랭킹: 내 정보 공개를 켠 팀원의 수익률 순위. 수익률은 직전 장마감 종가로 평가한다 (Ranking.pricesAsOf — 오늘 산 보유는 체결가, docs/API.md "장마감 기준").
// 하단 탭에서 빠져서 홈·마이의 랭킹 카드로 들어온다. 순서: 나(내 순위 또는 공개 스위치) → 전체 순위 → 계산식.
// 비공개로 온 사람의 목적은 '나도 나오게'라서 그 자리에 공개 스위치를 둔다 (마이까지 가지 않고 한 번에). 켜면 내 줄이 목록에 새로 붙는다.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { errorMessage } from "../api/client";
import { useUpdateProfile } from "../api/profile";
import { useRanking } from "../api/queries";
import type { Ranking, RankingEntry } from "../api/types";
import { PricesAsOfLine } from "../components/AssetCard";
import { Icon } from "../components/Icon";
import { useToast } from "../components/toast";
import { Card, EmptyState, ErrorState, Flash, Medal, PageHeader, RateText, SkeletonCard, Switch } from "../components/ui";
import { markShown, useChanged, useNewKeys, useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";

function Entry({ e, fresh }: { e: RankingEntry; fresh: boolean }) {
  const top = e.rank <= 3;
  // 순위가 바뀐 순간(추월)에만 순위 원이 한 번 튄다. key가 닉네임이라 줄은 그대로 남아 수익률 Flash도 이전 값을 기억한다
  // (그래서 순서가 바뀌면 React가 줄을 옮긴다 — 새 줄의 등장은 끝나면 markShown으로 멈춰, 옮겨져도 다시 올라오지 않는다)
  const moved = useChanged(e.rank);
  return (
    <li
      aria-current={e.isMe ? "true" : undefined}
      className={cn("flex items-center gap-3 px-5 py-3", e.isMe && "bg-brand-soft", fresh && "is-new")}
      onAnimationEnd={fresh ? markShown : undefined}
    >
      <Medal key={e.rank} rank={e.rank} className={moved ? "animate-pop-in" : undefined} />
      <span className={cn("min-w-0 flex-1 truncate", top ? "text-[17px] font-bold" : "text-[16px] font-medium")}>
        {e.nickname}
        {e.isMe && <span className="ml-1.5 rounded-md bg-brand px-1.5 py-0.5 align-middle text-[11px] font-bold text-white">나</span>}
      </span>
      <Flash value={e.profitRate}>
        <RateText rate={e.profitRate} className={cn("font-bold", top ? "text-[17px]" : "text-[15px]")} />
      </Flash>
    </li>
  );
}

/**
 * 비공개일 때: 지금 내 수익률과 그 자리 공개 스위치. 켜면 랭킹을 다시 받아 내 줄이 생긴다.
 * onPublished: 저장이 끝난 공개 여부 (랭킹 다시 받기는 그 뒤라 이때 이 스위치는 아직 화면에 있다).
 */
function GoPublic({ ranking, onPublished }: { ranking: Ranking; onPublished: (isPublic: boolean) => void }) {
  const toast = useToast();
  const profile = useUpdateProfile();
  const [pending, setPending] = useState<boolean | null>(null);
  return (
    <div>
      <p className="text-[16px] font-semibold">아직 랭킹에 내가 없어요</p>
      <p className="mt-1 text-[14px] leading-relaxed text-sub">
        지금 내 수익률은 <RateText rate={ranking.me.profitRate} className="font-semibold" />
        예요. 공개하기 전에는 다른 팀원에게 보이지 않아요.
      </p>
      <div className="mt-3 border-t border-line pt-2">
        <Switch
          checked={pending ?? ranking.me.isPublic}
          busy={profile.isPending}
          describedBy="rank-public-help"
          className="min-h-11"
          label={<span className="text-[16px] font-semibold">랭킹에 내 수익률 공개</span>}
          onChange={(isPublic) => {
            if (profile.isPending) return; // 저장 중에는 막지 않고(포커스 유지) 누름만 무시한다
            setPending(isPublic);
            profile.mutate(
              { isPublic },
              {
                onSuccess: (m) => {
                  onPublished(m.isPublic);
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
        <p id="rank-public-help" className="text-[13px] text-sub">
          닉네임과 수익률만 나와요. 금액·보유 종목은 공개되지 않아요.
        </p>
      </div>
    </div>
  );
}

/**
 * 공개했을 때: 내 순위와 수익률을 같은 줄 높이에 (라벨 → 값).
 * focusOnMount: 이 화면에서 방금 공개를 켰으면 사라진 스위치 대신 새 순위로 포커스를 옮긴다 (body로 떨어지지 않게).
 */
function MyRank({ ranking, focusOnMount }: { ranking: Ranking; focusOnMount: boolean }) {
  const box = useRef<HTMLDListElement>(null);
  useEffect(() => {
    if (focusOnMount) box.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  return (
    <>
      <dl ref={box} tabIndex={-1} className="grid grid-cols-2 gap-x-3 outline-none">
        <div>
          <dt className="text-[14px] text-sub">내 순위</dt>
          <dd className="mt-0.5 flex items-baseline gap-1">
            <span className="text-[26px] leading-tight font-bold tabular-nums">{ranking.me.rank != null ? `${ranking.me.rank}위` : "-"}</span>
            <span className="text-[14px] text-mute tabular-nums">/ {ranking.results.length}명</span>
          </dd>
        </div>
        <div className="text-right">
          <dt className="text-[14px] text-sub">수익률</dt>
          <dd className="mt-0.5">
            <RateText rate={ranking.me.profitRate} className="text-[26px] leading-tight font-bold" />
          </dd>
        </div>
      </dl>
      <Link
        to="/my#public"
        className="press-row -mx-2 mt-2 flex min-h-11 items-center gap-0.5 rounded-xl px-2 text-[14px] font-semibold text-mute hover:bg-fill/60"
      >
        공개 설정은 마이에서
        <Icon name="chevron" className="size-4" />
      </Link>
    </>
  );
}

export function RankingPage() {
  const { data, isPending, isError, error, refetch, isFetching } = useRanking();
  const reveal = useRevealAfterLoading(isPending);
  const isPublic = data?.me.isPublic ?? false;
  // 이 화면에서 공개를 켰는지. 사라진 스위치 대신 내 순위로 포커스를 옮기고 그 칸을 페이드하는 것은 이때뿐이다 —
  // 캐시 없이 처음 받은 공개 상태(불러오는 동안은 false로 셈)·폴링으로 받은 다른 곳의 변경은 사용자가 여기서 바꾼 것이 아니다.
  // 다른 곳에서 다시 비공개로 바꾸면(공개 → 비공개) 지운다: 그다음 공개도 이 화면의 동작일 때만 센다
  const [published, setPublished] = useState(false);
  const [wasPublic, setWasPublic] = useState(isPublic);
  if (wasPublic !== isPublic) {
    setWasPublic(isPublic); // 렌더 중 조건부 파생 상태
    if (!isPublic) setPublished(false);
  }
  // 공개를 켜거나 다른 팀원이 새로 공개해 목록에 붙은 줄만 움직인다 (처음 그림·폴링 갱신은 그대로)
  const fresh = useNewKeys(data?.results.map((e) => e.nickname) ?? [], !isPending);
  return (
    // PC: 목록 화면 폭 규칙(알림과 같은 760px, 제목과 같은 왼쪽 선). 머리도 같은 폭이라 오른쪽 끝이 본문과 맞는다
    <div className="lg:max-w-[760px]">
      <PageHeader title="랭킹" back />
      {isPending ? (
        <div className="space-y-3">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={6} />
        </div>
      ) : isError ? (
        <Card>
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />
        </Card>
      ) : (
        <div className={cn("space-y-3", reveal && "reveal-fade")}>
          <Card aria-label="내 순위">
            <div key={isPublic ? "public" : "private"} className={published ? "reveal-fade" : undefined}>
              {isPublic ? <MyRank ranking={data} focusOnMount={published} /> : <GoPublic ranking={data} onPublished={setPublished} />}
            </div>
          </Card>

          <section aria-labelledby="rank-title" className="overflow-hidden rounded-2xl bg-card">
            <div className="px-5 pt-5 pb-2">
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="rank-title" className="text-[17px] font-bold">
                  수익률 순위
                </h2>
                <span className="text-[12px] text-mute tabular-nums">{formatDateTime(data.asOf)} 계산</span>
              </div>
              <PricesAsOfLine pricesAsOf={data.pricesAsOf} className="mt-0.5" />
            </div>
            {data.results.length === 0 ? (
              <EmptyState compact icon="trophy" title="아직 공개한 팀원이 없어요">
                내 정보 공개를 켠 팀원만 나와요.
              </EmptyState>
            ) : (
              <ol className="pb-2" aria-label="랭킹 목록">
                {data.results.map((e) => (
                  <Entry key={e.nickname} e={e} fresh={fresh.has(e.nickname)} />
                ))}
              </ol>
            )}
          </section>
          <p className="px-1 text-[13px] leading-relaxed text-mute">
            수익률 = 총자산 ÷ 초기 자금 − 1 (보유 종목은 직전 장마감 종가로 평가 — 오늘 산 종목은 장 마감 뒤까지 산 가격으로). 내 정보 공개를 켠 팀원만
            나와요.
          </p>
        </div>
      )}
    </div>
  );
}
