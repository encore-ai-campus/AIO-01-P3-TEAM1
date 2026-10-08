// 마이의 알림 설정: "Discord로도 받기" → (켰을 때만) Discord 사용자 ID(멘션용) → 테스트 알림.
// 대부분은 웹 알림만 보고 Discord는 한 번 설정하므로 세부(ID·찾는 법)는 켰을 때만 펼친다 (아래 설정이 덜 묻히게).
// 웹 알림 문장은 받는 사람의 주린이모드를 따르고, Discord(팀 공용 채널)는 쉬운 문장 + 숫자 한 줄 하나로 간다 (docs/API.md B6).
// 서버에 Webhook이 없으면(webhookConfigured=false) Discord 묶음(받기 스위치·사용자 ID·ID 찾는 법·테스트 알림)을 접고 "지금은 웹 알림으로만 와요" 한 줄만 보인다 —
// 쓸 수 없는 기능이고 초보자는 Discord 사용자 ID가 무엇인지 모른다 (UX-14). 미리 ID를 넣어 두려는 사람은 펼칠 수 있다.
import { useState } from "react";
import { useTestNotification, useUpdateNotificationSettings } from "../../api/autotrade";
import { errorMessage } from "../../api/client";
import { useNotificationSettings } from "../../api/queries";
import type { NotificationSettings } from "../../api/types";
import { useRevealAfterLoading } from "../../hooks/useMotionState";
import { checkDiscordId } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { Icon } from "../Icon";
import { Collapse } from "../motion/Collapse";
import { useToast } from "../toast";
import { Card, ErrorState, SkeletonCard, Spinner, Switch } from "../ui";

function DiscordIdForm({ s }: { s: NotificationSettings }) {
  const toast = useToast();
  const update = useUpdateNotificationSettings();
  const [raw, setRaw] = useState(s.discordUserId ?? "");
  const [touched, setTouched] = useState(false);
  const check = checkDiscordId(raw);
  const changed = (check.value ?? null) !== (s.discordUserId ?? null);
  const showError = touched && check.error;
  return (
    <form
      className="space-y-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (check.error || !changed) return;
        update.mutate(
          { discordUserId: check.value },
          {
            onSuccess: (n) => {
              // 칸을 다시 그리지 않고(Enter로 저장해도 포커스가 남게) 저장된 값으로만 맞춘다
              setRaw(n.discordUserId ?? "");
              setTouched(false);
              toast(n.discordUserId ? "Discord 사용자 ID를 저장했어요. 알림에 나를 멘션해요." : "Discord 사용자 ID를 지웠어요.", "success");
            },
            onError: (err) => toast(errorMessage(err), "error"),
          },
        );
      }}
    >
      <label htmlFor="discord-id" className="block text-[16px] font-semibold">
        Discord 사용자 ID
      </label>
      <div className="flex gap-2">
        <input
          id="discord-id"
          inputMode="numeric"
          autoComplete="off"
          value={raw}
          maxLength={24}
          placeholder="숫자 17~20자리"
          onChange={(e) => setRaw(e.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={showError ? true : undefined}
          aria-describedby="discord-id-help discord-id-error"
          className={cn(
            "h-12 min-w-0 flex-1 rounded-xl bg-fill px-3.5 text-[16px] tabular-nums outline-none placeholder:text-mute-weak focus:ring-2 focus:ring-brand",
            showError && "ring-2 ring-up",
          )}
        />
        <button
          type="submit"
          disabled={!changed || update.isPending}
          className="press flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
        >
          {update.isPending && <Spinner />}
          저장
        </button>
      </div>
      {showError && (
        <p id="discord-id-error" role="alert" className="text-[13px] font-medium text-up-ink">
          {check.error}
        </p>
      )}
      <p id="discord-id-help" className="text-[13px] leading-relaxed text-sub">
        넣어 두면 Discord 알림에 나를 멘션해요. 비우고 저장하면 지워요.
      </p>
      <details className="group">
        <summary className="-mx-2 flex min-h-11 w-fit cursor-pointer list-none items-center gap-1 rounded-xl px-2 text-[13px] font-semibold text-sub transition-colors hover:bg-fill/60 active:bg-fill [&::-webkit-details-marker]:hidden">
          ID 찾는 법
          <Icon name="chevron-down" className="size-4 text-mute-weak transition-transform duration-fast group-open:rotate-180" />
        </summary>
        <p className="pb-1 text-[13px] leading-relaxed text-sub">Discord 설정 → 고급 → 개발자 모드 켜기 → 내 프로필 우클릭 → ID 복사</p>
      </details>
    </form>
  );
}

/** "Discord로도 받기" + 켰을 때만 사용자 ID. 누르자마자 바뀐 상태를 보이고, 실패하면 서버 값으로 돌아간다 (다시 그리지 않아 포커스가 남는다). */
function DiscordSection({ s }: { s: NotificationSettings }) {
  const toast = useToast();
  const update = useUpdateNotificationSettings();
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? s.discordEnabled;
  return (
    <div>
      <Switch
        checked={on}
        busy={update.isPending}
        describedBy="discord-help"
        className="min-h-11"
        label={<span className="text-[16px] font-semibold">Discord로도 받기</span>}
        onChange={(next) => {
          if (update.isPending) return; // 저장 중에는 막지 않고(포커스 유지) 누름만 무시한다
          setPending(next);
          update.mutate(
            { discordEnabled: next },
            {
              onSuccess: (n) => {
                setPending(null);
                toast(n.discordEnabled ? "알림을 Discord로도 보내요." : "Discord로는 보내지 않아요. 웹 알림만 와요.", "success");
              },
              onError: (err) => {
                setPending(null);
                toast(errorMessage(err), "error");
              },
            },
          );
        }}
      />
      {s.webhookConfigured ? (
        <p id="discord-help" className="text-[13px] text-sub">
          웹 알림은 항상 남아요.
        </p>
      ) : (
        <p id="discord-help" className="flex items-start gap-1.5 text-[13px] leading-snug text-warn-ink">
          <Icon name="alert" className="mt-px size-4 shrink-0" />
          지금은 서버 설정 전이라 웹으로만 와요.
        </p>
      )}
      <Collapse open={on}>
        <div className="pt-4">
          <div className="border-t border-line pt-4">
            <DiscordIdForm s={s} />
          </div>
        </div>
      </Collapse>
    </div>
  );
}

export function NotificationSettingsCard() {
  const toast = useToast();
  const { data: s, isPending, isError, error, refetch, isFetching } = useNotificationSettings();
  const test = useTestNotification();
  const reveal = useRevealAfterLoading(isPending);
  const [showDiscord, setShowDiscord] = useState(false);
  if (isPending) return <SkeletonCard lines={4} />;
  if (isError) {
    return (
      <Card>
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />
      </Card>
    );
  }
  const discord = (
    <>
      <DiscordSection s={s} />
      <button
        type="button"
        disabled={test.isPending}
        onClick={() =>
          test.mutate(undefined, {
            onSuccess: (r) => toast(r.detail, "success"),
            onError: (err) => toast(errorMessage(err), "error"),
          })
        }
        className="press flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-fill text-[15px] font-semibold text-ink hover:bg-line disabled:opacity-40"
      >
        {test.isPending ? <Spinner /> : <Icon name="bell" className="size-4" />}
        테스트 알림 보내기
      </button>
    </>
  );
  return (
    <Card aria-labelledby="noti-settings-title" className={cn("space-y-4", reveal && "reveal-fade")}>
      <div>
        <h2 id="noti-settings-title" className="flex items-center gap-1.5 text-[17px] font-bold">
          <Icon name="bell" className="size-5 text-mute-weak" />
          알림 설정
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-sub">
          웹 알림 문장은 주린이모드를 따라요. 오늘의 내 종목 뉴스·펀더멘털 점검 알림은 웹에만 와요.
        </p>
      </div>
      {s.webhookConfigured ? (
        discord
      ) : (
        <div>
          <p className="flex items-start gap-1.5 text-[15px] leading-snug font-semibold">
            <Icon name="info" className="mt-0.5 size-4 shrink-0 text-mute-weak" />
            지금은 웹 알림으로만 와요.
          </p>
          <button
            type="button"
            aria-expanded={showDiscord}
            aria-controls={showDiscord ? "discord-settings" : undefined}
            onClick={() => setShowDiscord((v) => !v)}
            className="press -mx-2 mt-1 flex min-h-11 w-[calc(100%+1rem)] items-center justify-between gap-2 rounded-xl px-2 text-left text-[14px] font-semibold text-sub hover:bg-fill/60"
          >
            Discord 알림 설정 (서버 설정 전)
            <Icon name="chevron-down" className={cn("size-5 shrink-0 text-mute-weak transition-transform duration-fast", showDiscord && "rotate-180")} />
          </button>
          <Collapse open={showDiscord} id="discord-settings">
            <div className="space-y-4 pt-3">{discord}</div>
          </Collapse>
        </div>
      )}
    </Card>
  );
}
