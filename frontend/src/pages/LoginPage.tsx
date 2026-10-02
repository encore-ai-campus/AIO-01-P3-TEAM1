import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { api, errorMessage } from "../api/client";
import { keys, useMe } from "../api/queries";
import type { Me } from "../api/types";
import { Spinner } from "../components/ui";

const input =
  "h-14 w-full rounded-2xl bg-fill px-4 text-[17px] outline-none placeholder:text-mute focus:ring-2 focus:ring-brand";

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const { data: me } = useMe();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () => api.post<Me>("/api/auth/login", { username: username.trim(), password }),
    onSuccess: (user) => {
      // 다른 계정으로 받은 데이터가 남지 않게 비우고 새 로그인 정보를 넣는다
      qc.removeQueries();
      qc.setQueryData(keys.me, user);
      navigate(from, { replace: true });
    },
  });

  if (me && !login.isPending) return <Navigate to={from} replace />;

  return (
    <main className="grid min-h-dvh place-items-center bg-card px-4 py-10 lg:bg-bg">
      <div className="w-full max-w-[400px] lg:rounded-3xl lg:bg-card lg:p-10">
        <div className="mb-8">
          <span className="grid size-12 place-items-center rounded-2xl bg-brand text-[22px] font-extrabold text-white">모</span>
          <h1 className="mt-5 text-[26px] leading-snug font-bold">
            팀 모의매매에
            <br />
            로그인하세요
          </h1>
          <p className="mt-2 text-[15px] text-sub">팀원 계정 아이디와 비밀번호를 입력해 주세요.</p>
        </div>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (username.trim() && password) login.mutate();
          }}
        >
          <label className="block">
            <span className="sr-only">아이디</span>
            <input
              className={input}
              name="username"
              autoComplete="username"
              placeholder="아이디"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="sr-only">비밀번호</span>
            <input
              className={input}
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {login.isError && (
            <p role="alert" className="px-1 text-[14px] font-medium text-up">
              {errorMessage(login.error)}
            </p>
          )}
          <button
            type="submit"
            disabled={!username.trim() || !password || login.isPending}
            className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[17px] font-bold text-white hover:bg-brand-dark disabled:opacity-40"
          >
            {login.isPending && <Spinner />}
            로그인
          </button>
        </form>
        {import.meta.env.VITE_MOCK === "1" && (
          <p className="mt-6 rounded-xl bg-fill p-3 text-[13px] text-sub">
            가짜 API 모드입니다. <b>alice / alice1234</b> (비공개 계정은 <b>carol / carol1234</b>)
          </p>
        )}
      </div>
    </main>
  );
}
