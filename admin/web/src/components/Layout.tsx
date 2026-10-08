import { NavLink, Navigate, Outlet, useLocation } from "react-router";
import { useSyncExternalStore } from "react";
import { apiState, subscribeApiState } from "../api";
import { useAuth } from "../auth";
import { fmtClock } from "../format";
import { getUpdatedAt, requestRefresh, subscribeRefresh } from "../refresh";

const MENU = [
  { to: "/", label: "개요", end: true },
  { to: "/service", label: "서비스 상태" },
  { to: "/engine", label: "엔진 상태" },
  { to: "/deploys", label: "배포 기록" },
  { to: "/reports", label: "리포트 장애" },
  { to: "/recovery", label: "복구 지표" },
  { to: "/costs", label: "AI 비용" },
  { to: "/alerts", label: "알림·작업 실패" },
  { to: "/tools", label: "MCP 도구·호출" },
];

/** 로그인하지 않았으면 /login으로 보낸다. 가려던 경로는 state.from에 담는다. */
export function RequireAuth() {
  const { me } = useAuth();
  const location = useLocation();
  if (me === undefined) return <p className="muted center-note">확인 중…</p>;
  if (me === null) {
    const from = location.pathname + location.search;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return <Frame username={me.username} />;
}

function Frame({ username }: { username: string }) {
  const { logout } = useAuth();
  const dbDown = useSyncExternalStore(subscribeApiState, apiState.dbDown);
  const updatedAt = useSyncExternalStore(subscribeRefresh, getUpdatedAt);

  return (
    <div className="frame">
      <nav className="sidebar" aria-label="메뉴">
        <div className="brand">모매매 관리자</div>
        {MENU.map((m) => (
          <NavLink key={m.to} to={m.to} end={m.end} className={({ isActive }) => (isActive ? "active" : undefined)}>
            {m.label}
          </NavLink>
        ))}
      </nav>
      <div className="main">
        <header className="topbar">
          <span className="who">{username}</span>
          <span className="muted">마지막 갱신 {updatedAt ? fmtClock(new Date(updatedAt)) : "–"}</span>
          <button type="button" onClick={requestRefresh}>
            새로 고침
          </button>
          <button type="button" onClick={() => void logout()}>
            로그아웃
          </button>
        </header>
        {dbDown && (
          <div className="notice error" role="alert">
            서비스 DB에 연결할 수 없습니다
          </div>
        )}
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
