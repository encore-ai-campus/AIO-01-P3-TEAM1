// 로그인. 순서: 정체성(로고·이름·부제) → 가치(풀이 한 줄·3단계) → 입력 → 결정(로그인) → 안심('실제 주문은 나가지 않아요').
// 머리는 가로 가운데 정렬(브랜드 첫 화면), 세로는 위쪽 1/3에 맞춰 둔다 (세로 가운데 정렬은 오류 한 줄에 화면 전체가 흔들린다).
// 오류 줄 자리는 미리 잡아 둔다. 같은 말을 두 번 하지 않는다: '가상 현금으로 모의투자'는 풀이 한 줄이 말하고, 아래 안심 줄은 '실제 주문은 나가지 않아요'만.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { api, errorMessage } from "../api/client";
import { keys, useMe } from "../api/queries";
import type { Me } from "../api/types";
import { BrandMark, Wordmark } from "../components/brand/BrandMark";
import { Icon } from "../components/Icon";
import { Notice, Spinner } from "../components/ui";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { cn } from "../lib/cn";
import { SERVICE_INTRO, SERVICE_NAME, SERVICE_TAGLINE } from "../lib/plainText";
import { clearSessionExpired, readSessionExpired } from "../lib/session";

const input =
  "h-14 w-full rounded-2xl bg-fill px-4 text-[17px] outline-none placeholder:text-mute focus:ring-2 focus:ring-brand aria-invalid:ring-2 aria-invalid:ring-up";
const ERROR_ID = "login-error";
const STEPS = ["리포트 만들기", "검토", "모의 자동매매"];

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const { data: me } = useMe();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // 로그인 상태였다가 세션이 끝나 온 경우 (RequireAuth의 AuthBridge가 남긴 표시). 한 번만 보이고 지운다
  const [expired] = useState(readSessionExpired);
  useEffect(() => {
    clearSessionExpired();
  }, []);
  useDocumentTitle("로그인");

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

  const empty = !username.trim() || !password;
  const invalid = login.isError || undefined;
  // 고치기 시작하면 오류 표시(빨간 테두리)를 거둔다. 문장 자리는 그대로라 화면이 흔들리지 않는다
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    if (login.isError) login.reset();
  };

  return (
    <main className="grid min-h-dvh items-start justify-items-center bg-card px-4 pt-[12dvh] pb-10 lg:place-items-center lg:bg-bg lg:py-10">
      <div className="w-full max-w-[400px] lg:rounded-3xl lg:bg-card lg:p-10">
        {expired && <Notice className="mb-6">로그인이 끝났어요. 다시 로그인하면 보던 화면으로 돌아가요.</Notice>}
        <div className="mb-8 flex flex-col items-center text-center">
          {/* 세로 잠금: 로고 56px → 마크의 1/4(14px) → 워드마크 높이 28px(이름은 제목 안의 숨김 글자가 읽는다) → 부제 14px */}
          <BrandMark size={56} loop />
          <h1 className="mt-3.5 flex text-ink">
            <span className="sr-only">{SERVICE_NAME}</span>
            <Wordmark height={28} />
          </h1>
          <p className="mt-1.5 text-[14px] leading-snug font-medium text-sub">{SERVICE_TAGLINE}</p>
          <p className="mt-5 text-[15px] leading-relaxed text-balance text-sub">{SERVICE_INTRO}</p>
          <ol aria-label="이용 순서" className="mt-4 flex flex-wrap justify-center gap-1.5">
            {STEPS.map((s, i) => (
              <li
                key={s}
                className="flex h-7 items-center gap-1 rounded-full bg-brand-soft px-2.5 text-[13px] font-semibold whitespace-nowrap text-brand-ink"
              >
                <span aria-hidden="true" className="tabular-nums">
                  {"①②③"[i]}
                </span>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (login.isPending) return; // 진행 중에 두 번 보내지 않는다 (버튼은 색을 유지한다)
            if (username.trim() && password) login.mutate();
          }}
        >
          <label className="block">
            <span className="sr-only">아이디</span>
            <input
              className={input}
              name="username"
              autoComplete="username"
              // 팀 아이디는 소문자·숫자다. 휴대폰 키보드가 첫 글자를 대문자로 바꾸거나 고치지 않게
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              placeholder="아이디"
              aria-invalid={invalid}
              aria-describedby={invalid && ERROR_ID}
              value={username}
              onChange={(e) => edit(setUsername)(e.target.value)}
            />
          </label>
          <div className="relative">
            <label className="block">
              <span className="sr-only">비밀번호</span>
              <input
                className={cn(input, "pr-14")}
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                placeholder="비밀번호"
                aria-invalid={invalid}
                aria-describedby={invalid && ERROR_ID}
                value={password}
                onChange={(e) => edit(setPassword)(e.target.value)}
              />
            </label>
            {/* 무작위 12자를 휴대폰에서 보지 않고 치기 어렵다. 눌러도 입력칸의 포커스·커서는 그대로 둔다 */}
            <button
              type="button"
              aria-label="비밀번호 보기"
              aria-pressed={showPassword}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute top-1.5 right-1.5 grid size-11 place-items-center rounded-xl text-mute transition-colors hover:bg-line/60 hover:text-sub active:bg-line/60"
            >
              <Icon name={showPassword ? "eye-off" : "eye"} className="size-5" />
            </button>
          </div>
          {/* 오류 문장 자리: 미리 잡아 두어 오류가 떠도 아래 버튼이 밀리지 않는다 */}
          <div className="-my-1 min-h-5 px-1">
            {login.isError && (
              // 오류 글자는 up-ink (흰 카드 위 5.6:1). text-up은 가격 상승 숫자용이라 흰 바탕 위 작은 글자에서 AA(4.5:1)에 못 미친다
              <p id={ERROR_ID} role="alert" className="text-[14px] leading-5 font-medium text-up-ink">
                {errorMessage(login.error)}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={empty}
            aria-busy={login.isPending || undefined}
            className="press flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[17px] font-bold text-white hover:bg-brand-dark disabled:opacity-40"
          >
            {login.isPending && <Spinner />}
            {login.isPending ? "로그인 중…" : "로그인"}
          </button>
        </form>
        <p className="mt-6 text-center text-[13px] leading-relaxed text-mute">실제 주문은 나가지 않아요.</p>
        <p className="mt-1 text-center text-[13px] leading-relaxed text-mute">계정이 없으면 팀에 문의해 주세요.</p>
        {import.meta.env.VITE_MOCK === "1" && (
          <p className="mt-6 rounded-xl bg-fill p-3 text-[13px] text-sub">
            가짜 API 모드입니다. <b>alice / alice1234</b> (주린이모드 끔) · <b>bob / bob1234</b> (주린이모드 켬) · 비공개 계정{" "}
            <b>carol / carol1234</b>
          </p>
        )}
      </div>
    </main>
  );
}
