// 마이의 계정 카드: 누구로 들어왔는지(이름 @아이디)와 닉네임 바꾸기를 한 덩어리로 (드물게 쓰는 계정 조작이라 마이 끝, 로그아웃 바로 위).
import { useState } from "react";
import { errorMessage } from "../../api/client";
import { useUpdateProfile } from "../../api/profile";
import type { Me } from "../../api/types";
import { cn } from "../../lib/cn";
import { useToast } from "../toast";
import { Card, Spinner } from "../ui";

/** 받침에 따라 '로'·'으로' (ㄹ 받침은 '로'). 한글로 끝나지 않으면 '(으)로'. */
function withRo(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return `${word}(으)로`;
  const jong = code % 28;
  return `${word}${jong === 0 || jong === 8 ? "로" : "으로"}`;
}

/** 닉네임: 칸을 떠날 때·변경을 누를 때 칸 아래에 이유를 보인다 (서버가 거절한 이유 — 겹치는 닉네임 등 — 도 같은 자리). */
function NicknameForm({ me }: { me: Me }) {
  const toast = useToast();
  const profile = useUpdateProfile();
  const [nick, setNick] = useState(me.nickname);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const trimmed = nick.trim();
  const invalid = trimmed.length < 2 || trimmed.length > 12;
  const error = touched && invalid ? "닉네임은 2~12자로 적어 주세요." : serverError;
  // 바뀐 것이 없거나 저장 중이면 '변경'을 막지(disabled) 않고 aria-disabled로 알린다 — 막으면 누른 버튼의 포커스가 body로 떨어진다.
  // 누름은 아래 onSubmit이 무시한다
  const unavailable = trimmed === me.nickname || profile.isPending;
  return (
    <form
      className="space-y-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (profile.isPending) return;
        setTouched(true);
        if (invalid || trimmed === me.nickname) return;
        profile.mutate(
          { nickname: trimmed },
          {
            onSuccess: (m) => toast(`닉네임을 ${withRo(m.nickname)} 바꿨어요.`, "success"),
            onError: (err) => setServerError(errorMessage(err)),
          },
        );
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
          autoComplete="off"
          onChange={(e) => {
            setNick(e.target.value);
            setServerError(null);
          }}
          onBlur={() => setTouched(true)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "nickname-error nickname-help" : "nickname-help"}
          className={cn(
            "h-12 min-w-0 flex-1 rounded-xl bg-fill px-3.5 text-[16px] outline-none focus:ring-2 focus:ring-brand",
            error && "ring-2 ring-up",
          )}
        />
        <button
          type="submit"
          aria-disabled={unavailable || undefined}
          className={cn(
            "press flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark aria-disabled:opacity-40 aria-disabled:hover:bg-brand",
            profile.isPending && "cursor-progress",
          )}
        >
          {profile.isPending && <Spinner />}
          변경
        </button>
      </div>
      {error && (
        <p id="nickname-error" role="alert" className="text-[13px] font-medium text-up-ink">
          {error}
        </p>
      )}
      <p id="nickname-help" className="text-[13px] leading-relaxed text-sub">
        랭킹에 보이는 이름이에요. 2~12자, 다른 팀원과 겹치면 안 돼요.
      </p>
    </form>
  );
}

export function AccountCard({ me }: { me: Me }) {
  return (
    <Card aria-label="계정">
      <h2 className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[19px] font-bold">{me.nickname}</span> <span className="text-[14px] font-medium text-mute">@{me.username}</span>
      </h2>
      <div className="mt-4 border-t border-line pt-4">
        {/* key로 다시 그리지 않는다: 바꾼 뒤에도 입력 칸의 포커스가 남게 (칸의 값이 곧 새 닉네임이다) */}
        <NicknameForm me={me} />
      </div>
    </Card>
  );
}
