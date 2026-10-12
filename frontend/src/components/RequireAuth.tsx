import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { errorMessage, setUnauthorizedHandler } from "../api/client";
import { keys, useMe } from "../api/queries";
import { cn } from "../lib/cn";
import { markSessionExpired } from "../lib/session";
import { BrandLockup } from "./brand/BrandMark";
import { ErrorState, Skeleton } from "./ui";

/** API가 401을 주면 로그인 정보를 지운다 → RequireAuth가 로그인 화면으로 보낸다. 로그인 상태였다면 '세션이 끝남'을 남긴다 (로그인 화면이 알린다). */
export function AuthBridge() {
  const qc = useQueryClient();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      // /api/auth/me는 401을 따로 받는다(로그인 전 확인) — 여기 오는 401은 로그인한 채 쓰다가 끊긴 경우다
      if (qc.getQueryData(keys.me)) markSessionExpired();
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== keys.me[0] });
      qc.setQueryData(keys.me, null);
    });
    return () => setUnauthorizedHandler(null);
  }, [qc]);
  return null;
}

/**
 * 로그인 확인 중 화면. 빠르면(300ms 안) 아무것도 보이지 않고, 늦으면 앱 뼈대(왼쪽 메뉴·머리·카드·하단 탭 자리)가 살며시 나타난다.
 * 다음 화면의 구조를 먼저 보여 줘 '툭' 나타나는 느낌을 줄인다. 움직임 줄이기면 지연 없이 바로 보인다.
 */
function BootScreen() {
  return (
    <div aria-busy="true" aria-label="불러오는 중" className="min-h-dvh">
      <div className="animate-fade-in" style={{ animationDelay: "300ms" }}>
        <div className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-line bg-card px-4 py-6 lg:flex">
          {/* 왼쪽 메뉴(Layout)의 브랜드와 같은 자리·크기 — 뼈대가 실제 화면으로 바뀔 때 로고가 움직이지 않게 */}
          <div className="mb-8 px-3">
            <BrandLockup size={32} className="text-[19px] text-ink" />
          </div>
          <div className="space-y-4 px-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-2/3" />
            ))}
          </div>
        </div>
        <div className="lg:pl-60">
          <div className="mx-auto w-full max-w-[1120px] space-y-3 px-4 lg:px-8 lg:pt-8">
            <div className="flex h-14 items-center px-2 lg:h-auto lg:px-0">
              <Skeleton className="h-6 w-28 lg:h-8 lg:w-40" />
            </div>
            {/* 카드 자리 (바탕 위 카드색. Skeleton은 회색이라 직접 그린다) */}
            {["h-36", "h-24", "h-48"].map((h) => (
              <div key={h} aria-hidden="true" className={cn("skeleton w-full rounded-2xl bg-card", h)} />
            ))}
          </div>
        </div>
        <div className="fixed inset-x-0 bottom-0 h-16 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] lg:hidden" />
      </div>
    </div>
  );
}

/** 로그인해야 볼 수 있는 화면. 미로그인이면 /login으로 (돌아올 주소를 state.from에). */
export function RequireAuth() {
  const location = useLocation();
  const { data: me, isPending, isError, error, refetch, isFetching } = useMe();

  if (isPending) return <BootScreen />;
  if (isError) {
    return (
      <div className="grid min-h-dvh place-items-center px-4">
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return <Outlet />;
}
