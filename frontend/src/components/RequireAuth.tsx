import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { errorMessage, setUnauthorizedHandler } from "../api/client";
import { keys, useMe } from "../api/queries";
import { ErrorState, Spinner } from "./ui";

/** API가 401을 주면 로그인 정보를 지운다 → RequireAuth가 로그인 화면으로 보낸다. */
export function AuthBridge() {
  const qc = useQueryClient();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== keys.me[0] });
      qc.setQueryData(keys.me, null);
    });
    return () => setUnauthorizedHandler(null);
  }, [qc]);
  return null;
}

/** 로그인해야 볼 수 있는 화면. 미로그인이면 /login으로 (돌아올 주소를 state.from에). */
export function RequireAuth() {
  const location = useLocation();
  const { data: me, isPending, isError, error, refetch } = useMe();

  if (isPending) {
    return (
      <div className="grid min-h-dvh place-items-center text-brand" aria-busy="true" aria-label="불러오는 중">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="grid min-h-dvh place-items-center px-4">
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return <Outlet />;
}
