// 로그인. 순서: 정체성(로고·이름·부제) → 가치(풀이 한 줄·3단계) → 입력 → 결정(로그인) → 안심('실제 주문은 나가지 않아요').
// 머리는 가로 가운데 정렬(브랜드 첫 화면), 세로는 위쪽 1/3에 맞춰 둔다 (세로 가운데 정렬은 오류 한 줄에 화면 전체가 흔들린다).
// 오류 줄 자리는 미리 잡아 둔다. 같은 말을 두 번 하지 않는다: '가상 현금으로 모의투자'는 풀이 한 줄이 말하고, 아래 안심 줄은 '실제 주문은 나가지 않아요'만.
// PC(lg+, 시연 첫 화면): 왼쪽 = 브랜드·가치(마크+워드마크 잠금, 부제, 풀이 한 줄을 큰 문장으로, 3단계를 아이콘 줄로, 돈 안심 한 줄), 오른쪽 = 로그인 카드.
//   DOM 순서는 모바일과 같다(안내 → 머리 → 카드 → 시연용 계정). 자리는 그리드로만 옮긴다: 머리는 왼쪽 열 전체, 안내·카드·계정은 오른쪽 열의 가운데 줄들.
//   새 움직임은 없다 (마크의 반복은 인트로가 도는 동안 멈춰 있다 — index.css .brand-hop).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { IconName } from "../components/Icon";
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
// 이용 순서. 풀이(desc)와 아이콘은 PC 왼쪽 열에서만 보인다 (모바일은 알약 셋). 단계 이름 칸이 li의 첫 자식이다 — 아이콘은 그리드로 왼쪽에 놓는다
const STEPS: { label: string; desc: string; icon: IconName }[] = [
  { label: "리포트 만들기", desc: "종목을 고르면 여러 AI가 조사하고 서로 따져 봐요", icon: "doc" },
  { label: "검토", desc: "근거와 위험을 읽고, 매매 계획을 직접 확인해요", icon: "check-circle" },
  { label: "모의 자동매매", desc: "정한 금액만큼 가상 현금으로 계획대로 사고팔아요", icon: "play" },
];
/** 시연용 계정 안내를 PC에서 접어 둘지 (모바일은 늘 펼친다 — 접는 줄 자체가 없다). */
const wideScreen = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1024px)").matches;

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const { data: me } = useMe();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [demoOpen, setDemoOpen] = useState(() => !wideScreen());
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
    <main className="grid min-h-dvh items-start justify-items-center bg-card px-4 pt-[12dvh] pb-10 lg:place-items-center lg:bg-bg lg:px-8 lg:py-12">
      <div className="login-stage w-full max-w-[400px] lg:grid lg:max-w-[1120px] lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[1fr_auto_auto_auto_1fr] lg:gap-x-16 xl:grid-cols-[minmax(0,1fr)_420px] xl:gap-x-24">
        {expired && <Notice className="mb-6 lg:col-start-2 lg:row-start-2 lg:mb-4">로그인이 끝났어요. 다시 로그인하면 보던 화면으로 돌아가요.</Notice>}
        <div className="mb-8 flex flex-col items-center text-center lg:col-start-1 lg:row-span-full lg:mb-0 lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center lg:self-center lg:text-left">
          {/* 세로 잠금: 로고 56px → 마크의 1/4(14px) → 워드마크 높이 28px(이름은 제목 안의 숨김 글자가 읽는다) → 부제 14px.
              PC는 가로 잠금: 마크 56 + 1/4 간격 + 워드마크 0.7배(40px), 부제는 그 아래 */}
          <BrandMark size={56} loop />
          <h1 className="mt-3.5 flex text-ink lg:mt-0 lg:ml-3.5">
            <span className="sr-only">{SERVICE_NAME}</span>
            <Wordmark height={28} className="lg:h-10 lg:w-auto" />
          </h1>
          <p className="mt-1.5 text-[14px] leading-snug font-medium text-sub lg:col-span-2 lg:mt-4 lg:text-[16px]">{SERVICE_TAGLINE}</p>
          <p className="mt-5 text-[15px] leading-relaxed text-balance text-sub lg:col-span-2 lg:mt-8 lg:max-w-[15em] lg:text-[34px] lg:leading-[1.35] lg:font-bold lg:tracking-[-0.01em] lg:text-ink xl:text-[38px]">
            {SERVICE_INTRO}
          </p>
          <ol
            aria-label="이용 순서"
            className="mt-4 flex flex-wrap justify-center gap-1.5 lg:col-span-2 lg:mt-10 lg:flex-col lg:flex-nowrap lg:justify-start lg:gap-3"
          >
            {STEPS.map((s, i) => (
              <li
                key={s.label}
                className="flex h-7 items-center gap-1 rounded-full bg-brand-soft px-2.5 text-[13px] font-semibold whitespace-nowrap text-brand-ink lg:grid lg:h-auto lg:grid-cols-[44px_minmax(0,1fr)] lg:gap-x-4 lg:gap-y-0.5 lg:rounded-none lg:bg-transparent lg:px-0 lg:whitespace-normal lg:text-ink"
              >
                <span className="inline-flex items-center gap-1 lg:col-start-2 lg:row-start-1 lg:text-[17px] lg:font-bold">
                  <span aria-hidden="true" className="tabular-nums lg:hidden">
                    {"①②③"[i]}
                  </span>
                  {s.label}
                </span>
                <span className="hidden text-[14px] leading-snug font-normal text-sub lg:col-start-2 lg:row-start-2 lg:block">{s.desc}</span>
                <span
                  aria-hidden="true"
                  className="hidden size-11 place-items-center rounded-xl bg-brand-soft text-brand-ink lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:grid"
                >
                  <Icon name={s.icon} className="size-5" />
                </span>
              </li>
            ))}
          </ol>
          <p className="hidden items-center gap-2 text-[14px] text-mute lg:col-span-2 lg:mt-10 lg:flex">
            <Icon name="shield" className="size-4 shrink-0" />
            시세는 증권사에서 받아 오고, 내 돈은 들지 않아요.
          </p>
        </div>
        <div className="lg:col-start-2 lg:row-start-3 lg:rounded-3xl lg:bg-card lg:p-10">
          <h2 className="mb-6 hidden text-[22px] font-bold text-ink lg:block">로그인</h2>
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
        </div>
        {import.meta.env.VITE_MOCK === "1" && (
          // 모바일은 늘 펼친 상자 그대로(접는 줄을 숨긴다). PC는 접힌 한 줄 — 시연 첫 화면에 개발용 안내가 크게 서 있지 않게
          <details
            open={demoOpen}
            onToggle={(e) => setDemoOpen(e.currentTarget.open)}
            className="mt-6 lg:col-start-2 lg:row-start-4 lg:mt-4"
          >
            <summary className="hidden h-11 cursor-pointer list-none items-center justify-center gap-1 rounded-xl text-[13px] font-semibold text-sub hover:bg-fill lg:flex [&::-webkit-details-marker]:hidden">
              시연용 계정 보기
              <Icon name="chevron-down" className={cn("size-4 transition-transform duration-fast", demoOpen && "rotate-180")} />
            </summary>
            <p className="rounded-xl bg-fill p-3 text-[13px] text-sub lg:mt-2 lg:bg-card lg:p-4">
              가짜 API 모드입니다. <b>alice / alice1234</b> (주린이모드 끔) · <b>bob / bob1234</b> (주린이모드 켬) · 비공개 계정{" "}
              <b>carol / carol1234</b>
            </p>
          </details>
        )}
      </div>
    </main>
  );
}
