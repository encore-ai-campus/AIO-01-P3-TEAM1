// 마이 (위에서 아래로 — PC는 왼쪽 열 | 오른쪽 열):
// 왼쪽(읽고 조작하는 주 흐름): 주린이모드(스위치·진단) → 내 성적(수익률·자산 추이·랭킹·내 정보 공개)
// 오른쪽(가끔 바꾸는 설정): 알림 설정 → 화면 모드(이 기기) → 계정(이름·닉네임) → 로그아웃
// 다른 화면이 설정 하나를 가리켜 보낼 때는 해시를 쓴다: /my#diagnosis · #public · #notification-settings · #theme
// (스크롤은 ScrollManager가 한다. id는 위쪽 카드가 다 그려진 뒤에 붙인다 — 일찍 붙이면 스크롤한 뒤 위 카드가 자라 대상이 밀린다.)
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import { api, errorMessage } from "../api/client";
import { keys, useAccount, useEquity, useMe, useNotificationSettings, useRanking } from "../api/queries";
import { NotificationSettingsCard } from "../components/autotrade/NotificationSettingsCard";
import { Icon } from "../components/Icon";
import { AccountCard } from "../components/my/AccountCard";
import { BeginnerModeCard } from "../components/my/BeginnerModeCard";
import { PerformanceCard } from "../components/my/PerformanceCard";
import { ThemeCard } from "../components/my/ThemeCard";
import { useToast } from "../components/toast";
import { PageHeader, Spinner } from "../components/ui";
import { useBeginnerMode } from "../hooks/useBeginnerMode";
import { cn } from "../lib/cn";

/** 해시로 가리킨 자리를 알려 주는 시간(ms). */
const ARRIVAL_MS = 1200;

/** 마이의 카드들이 처음 불러오기를 마쳤는지 (성공이든 실패든). 해시 대상의 id를 이때 붙인다. */
function usePageReady(): boolean {
  const account = useAccount();
  const equity = useEquity(30);
  const ranking = useRanking();
  const settings = useNotificationSettings();
  const { profile, profileError } = useBeginnerMode();
  return !account.isPending && !equity.isPending && !ranking.isPending && !settings.isPending && (profile !== undefined || profileError !== null);
}

function hashTarget(hash: string): string | null {
  if (hash.length < 2) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1); // 잘못된 인코딩이면 그대로 (ScrollManager와 같은 처리)
  }
}

/**
 * /my#public처럼 설정 하나를 가리켜 왔으면, 준비된 뒤 그 자리를 1.2초 물들여 '여기'라고 알리고 포커스를 그 자리로 옮긴다
 * (다음 Tab이 그 설정 안에서 시작하게 — 화면 읽기도 가리킨 설정을 읽는다). 이동마다(location.key) 한 번.
 * 앱 안 기록으로 돌아온 뒤로·앞으로(POP)는 하지 않는다: 보던 자리 복원이 우선이고 POP에서는 움직이지 않는다.
 * 처음 연 링크(새 탭·주소 입력 — 기록 상태가 없어 key가 'default')도 첫 이동이 POP이지만, 가리켜 온 것이라 알린다.
 */
function useArrival(ready: boolean): string | null {
  const { hash, key } = useLocation();
  const navType = useNavigationType();
  const returning = navType === "POP" && key !== "default";
  const target = ready && !returning ? hashTarget(hash) : null;
  const [shown, setShown] = useState<{ key: string; id: string; done: boolean } | null>(null);
  if (target && shown?.key !== key) setShown({ key, id: target, done: false }); // 렌더 중 조건부 파생 상태
  useEffect(() => {
    if (!shown || shown.done) return;
    const el = document.getElementById(shown.id);
    // ScrollManager는 해시 대상을 1.5초까지만 기다린다. 느린 망에서 그보다 늦게 준비됐고 아직 아무도 스크롤하지 않았으면 여기서 데려온다
    if (navType !== "POP" && window.scrollY === 0) el?.scrollIntoView?.({ block: "start" });
    // 포커스가 갈 곳 없이 남아 있을 때만(body·화면 제목 h1 — PageHeader가 이동 뒤 h1에 준다) 옮긴다. 이미 무언가를 조작 중이면 그대로
    const active = document.activeElement;
    if (!active || active === document.body || active.matches("h1, main")) el?.focus({ preventScroll: true });
    const t = window.setTimeout(() => setShown({ ...shown, done: true }), ARRIVAL_MS);
    return () => window.clearTimeout(t);
  }, [shown, navType]);
  return target && shown && !shown.done ? target : null;
}

/** 해시로 가리킬 수 있는 카드 자리. 가리켜 왔으면 테두리로 잠깐 알리고 포커스를 받는다 (테두리가 표시 역할 — 기본 윤곽선은 끈다). */
function Anchor({ id, lit, children }: { id?: string; lit: boolean; children: ReactNode }) {
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      className={cn("scroll-mt-16 rounded-2xl outline-none transition-shadow duration-slow", lit && "ring-2 ring-brand")}
    >
      {children}
    </div>
  );
}

export function MyPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: me } = useMe();
  const ready = usePageReady();
  const lit = useArrival(ready);
  const anchor = (id: string) => (ready ? id : undefined);
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
      <PageHeader title="마이" />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-3">
          <BeginnerModeCard diagnosisId={anchor("diagnosis")} diagnosisLit={lit === "diagnosis"} />
          <PerformanceCard me={me} publicId={anchor("public")} publicLit={lit === "public"} />
        </div>
        <div className="min-w-0 space-y-3">
          <Anchor id={anchor("notification-settings")} lit={lit === "notification-settings"}>
            <NotificationSettingsCard />
          </Anchor>
          <Anchor id={anchor("theme")} lit={lit === "theme"}>
            <ThemeCard />
          </Anchor>
          <AccountCard me={me} />
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="press flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-card text-[15px] font-semibold text-sub hover:bg-line disabled:opacity-50"
          >
            {logout.isPending ? <Spinner /> : <Icon name="logout" className="size-5" />}
            로그아웃
          </button>
        </div>
      </div>
    </>
  );
}
