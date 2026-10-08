// 첫 로그인 닉네임 정하기 (UX-13): 닉네임이 아직 로그인 아이디 그대로면 홈 맨 위에서 "랭킹과 리포트에 보일 이름"을 한 번 묻는다.
// 닉네임 API(PATCH /api/me/profile)와 검증(2~12자, 겹치면 서버가 거절)은 마이의 계정 카드(AccountCard)와 같다.
// '나중에'는 사용자별로 이 브라우저에 기억한다 (저장 공간을 못 쓰면 이번 방문에만 접는다). 마이에서는 언제든 바꿀 수 있다.
import { useState } from "react";
import { errorMessage } from "../../api/client";
import { useUpdateProfile } from "../../api/profile";
import type { Me } from "../../api/types";
import { cn } from "../../lib/cn";
import { useToast } from "../toast";
import { Spinner } from "../ui";

const laterKey = (userId: number) => `nickname-prompt-later:${userId}`;

function readLater(userId: number): boolean {
  try {
    return localStorage.getItem(laterKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writeLater(userId: number) {
  try {
    localStorage.setItem(laterKey(userId), "1");
  } catch {
    // 저장 공간을 못 쓰면 이번 방문에만 접는다
  }
}

export function NicknamePrompt({ me }: { me: Me }) {
  const toast = useToast();
  const profile = useUpdateProfile();
  const [nick, setNick] = useState("");
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [later, setLater] = useState(() => readLater(me.id));
  // 닉네임을 바꾸면(me가 새로 오면) 저절로 사라진다. 아이디와 같게 정한 사람은 '나중에'로 접는다
  if (later || me.nickname !== me.username) return null;

  const trimmed = nick.trim();
  const invalid = trimmed.length < 2 || trimmed.length > 12;
  const error = touched && invalid ? "이름은 2~12자로 적어 주세요." : serverError;

  const dismiss = () => {
    writeLater(me.id);
    setLater(true);
  };

  return (
    <section aria-labelledby="nickname-prompt-title" className="mb-4 rounded-2xl bg-brand-soft p-4 ring-1 ring-brand/20">
      <h2 id="nickname-prompt-title" className="text-[16px] font-bold text-ink">
        랭킹과 리포트에 보일 이름을 정해 주세요
      </h2>
      <p id="nickname-prompt-help" className="mt-1 text-[14px] leading-relaxed text-sub">
        지금은 로그인 아이디(@{me.username})가 그대로 보여요. 2~12자, 다른 팀원과 겹치면 안 돼요. 마이에서 언제든 바꿀 수 있어요.
      </p>
      <form
        className="mt-3 space-y-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (profile.isPending) return;
          setTouched(true);
          if (invalid) return;
          if (trimmed === me.nickname) return dismiss(); // 아이디 그대로 쓰겠다는 뜻
          profile.mutate(
            { nickname: trimmed },
            {
              onSuccess: (m) => toast(`이름을 저장했어요. 랭킹과 리포트에 '${m.nickname}' 이름으로 보여요.`, "success"),
              onError: (err) => setServerError(errorMessage(err)),
            },
          );
        }}
      >
        <label htmlFor="nickname-prompt" className="sr-only">
          랭킹과 리포트에 보일 이름
        </label>
        <div className="flex gap-2">
          <input
            id="nickname-prompt"
            value={nick}
            maxLength={12}
            autoComplete="off"
            placeholder="예: 투자왕"
            onChange={(e) => {
              setNick(e.target.value);
              setServerError(null);
            }}
            onBlur={() => nick !== "" && setTouched(true)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "nickname-prompt-error nickname-prompt-help" : "nickname-prompt-help"}
            className={cn(
              "h-12 min-w-0 flex-1 rounded-xl bg-card px-3.5 text-[16px] outline-none focus:ring-2 focus:ring-brand",
              error && "ring-2 ring-up",
            )}
          />
          <button
            type="submit"
            aria-disabled={profile.isPending || undefined}
            className={cn(
              "press flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark aria-disabled:opacity-40 aria-disabled:hover:bg-brand",
              profile.isPending && "cursor-progress",
            )}
          >
            {profile.isPending && <Spinner />}
            저장
          </button>
        </div>
        {error && (
          <p id="nickname-prompt-error" role="alert" className="text-[13px] font-medium text-up-ink">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="press -ml-2 flex h-11 items-center rounded-xl px-2 text-[14px] font-semibold text-sub hover:text-ink"
        >
          나중에 할게요
        </button>
      </form>
    </section>
  );
}
