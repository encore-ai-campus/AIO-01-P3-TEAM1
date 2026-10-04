import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api, errorMessage } from "../api/client";
import { keys, useAccount, useEquity, useMe } from "../api/queries";
import type { Me } from "../api/types";
import { NotificationSettingsCard } from "../components/autotrade/NotificationSettingsCard";
import { Icon } from "../components/Icon";
import { LineChart } from "../components/LineChart";
import { useToast } from "../components/toast";
import { Card, ErrorState, Flash, PageHeader, Row, Skeleton, SkeletonCard, Spinner } from "../components/ui";
import { cn } from "../lib/cn";
import { formatKrw, formatRate, formatSignedKrw, trendClass } from "../lib/format";

function useProfile() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: { isPublic?: boolean; nickname?: string }) => api.patch<Me>("/api/me/profile", body),
    onSuccess: (me) => {
      qc.setQueryData(keys.me, me);
      void qc.invalidateQueries({ queryKey: keys.ranking });
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });
}

function AccountSection() {
  const { data: acc, isPending, isError, error, refetch } = useAccount();
  const { data: equity } = useEquity(30);
  if (isPending) return <SkeletonCard lines={6} />;
  if (isError) {
    return (
      <Card>
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      </Card>
    );
  }
  return (
    <Card aria-labelledby="my-account-title">
      <h2 id="my-account-title" className="text-[15px] font-semibold text-sub">
        내 수익률
      </h2>
      <p className={cn("mt-1 text-[32px] leading-tight font-bold tracking-tight", trendClass(acc.profitRate))}>
        <Flash value={acc.profitRate}>
          <span className="tabular-nums">{formatRate(acc.profitRate)}</span>
        </Flash>
      </p>
      <p className={cn("text-[15px] font-semibold tabular-nums", trendClass(acc.profitKrw))}>{formatSignedKrw(acc.profitKrw)}</p>
      <dl className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-fill p-3">
          <dt className="text-[13px] text-sub">투자금액</dt>
          <dd className="mt-0.5 text-[17px] font-bold tabular-nums">
            <Flash value={acc.investedKrw}>{formatKrw(acc.investedKrw)}</Flash>
          </dd>
        </div>
        <div className="rounded-xl bg-fill p-3">
          <dt className="text-[13px] text-sub">총자산</dt>
          <dd className="mt-0.5 text-[17px] font-bold tabular-nums">
            <Flash value={acc.equityKrw}>{formatKrw(acc.equityKrw)}</Flash>
          </dd>
        </div>
      </dl>
      <dl className="mt-3">
        <Row label="현금">{formatKrw(acc.cashKrw)}</Row>
        <Row label="보유 평가액">{formatKrw(acc.holdingsValueKrw)}</Row>
        <Row label="초기 자금">{formatKrw(acc.initialCapitalKrw)}</Row>
      </dl>
      <div className="mt-4 border-t border-line pt-4">
        <h3 className="mb-2 text-[15px] font-semibold text-sub">일별 자산 추이 (30일)</h3>
        {equity ? (
          <LineChart points={equity.points.map((p) => ({ day: p.day, value: p.equityKrw }))} label="일별 자산 추이" />
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </div>
    </Card>
  );
}

function PublicToggle({ me }: { me: Me }) {
  const toast = useToast();
  const profile = useProfile();
  // 누르자마자 바뀐 상태를 보여 주고, 실패하면 되돌린다
  const [checked, setChecked] = useState(me.isPublic);
  return (
    <div>
      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
        <span className="text-[16px] font-semibold">내 정보 공개</span>
        <input
          type="checkbox"
          checked={checked}
          disabled={profile.isPending}
          onChange={(e) => {
            const isPublic = e.target.checked;
            setChecked(isPublic);
            profile.mutate(
              { isPublic },
              {
                onSuccess: (m) => toast(m.isPublic ? "랭킹보드에 수익률을 공개합니다." : "랭킹보드에서 내 수익률을 숨겼습니다."),
                onError: () => setChecked(!isPublic),
              },
            );
          }}
          className="size-6 cursor-pointer accent-brand"
        />
      </label>
      <p className="mt-1 text-[14px] leading-relaxed text-sub">
        켜면 랭킹보드에 닉네임과 수익률이 공개됩니다. 금액·보유 종목은 공개되지 않습니다.
      </p>
    </div>
  );
}

function NicknameForm({ me }: { me: Me }) {
  const toast = useToast();
  const profile = useProfile();
  const [nick, setNick] = useState(me.nickname);
  const trimmed = nick.trim();
  const invalid = trimmed.length < 2 || trimmed.length > 12;
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid && trimmed !== me.nickname) {
          profile.mutate({ nickname: trimmed }, { onSuccess: (m) => toast(`닉네임을 ${m.nickname}(으)로 바꿨습니다.`) });
        }
      }}
    >
      <label htmlFor="nickname" className="block text-[16px] font-semibold">
        닉네임
      </label>
      <div className="flex gap-2">
        <input
          id="nickname"
          value={nick}
          maxLength={12}
          onChange={(e) => setNick(e.target.value)}
          className="h-12 min-w-0 flex-1 rounded-xl bg-fill px-3.5 text-[16px] outline-none focus:ring-2 focus:ring-brand"
          aria-describedby="nickname-help"
        />
        <button
          type="submit"
          disabled={invalid || trimmed === me.nickname || profile.isPending}
          className="flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
        >
          {profile.isPending && <Spinner />}
          변경
        </button>
      </div>
      <p id="nickname-help" className="text-[13px] text-mute">
        랭킹에 보이는 이름입니다. 2~12자, 다른 팀원과 겹치면 안 됩니다.
      </p>
    </form>
  );
}

export function MyPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: me } = useMe();
  const logout = useMutation({
    mutationFn: () => api.post<void>("/api/auth/logout"),
    onSuccess: () => {
      qc.removeQueries();
      qc.setQueryData(keys.me, null);
      navigate("/login", { replace: true });
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });

  if (!me) return null;
  return (
    <>
      <PageHeader title="My Page" />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
        <AccountSection />
        <div className="space-y-3">
          <Card>
            <p className="text-[20px] font-bold">{me.nickname}</p>
            <p className="text-[14px] text-mute">@{me.username}</p>
          </Card>
          <Card className="space-y-5" aria-label="설정">
            <PublicToggle me={me} />
            <div className="border-t border-line pt-5">
              <NicknameForm key={me.nickname} me={me} />
            </div>
          </Card>
          <NotificationSettingsCard />
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-card text-[15px] font-semibold text-sub hover:bg-line disabled:opacity-50"
          >
            <Icon name="logout" className="size-5" />
            로그아웃
          </button>
        </div>
      </div>
    </>
  );
}
