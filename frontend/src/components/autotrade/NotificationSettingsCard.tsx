// My Page 알림 설정: Discord 사용자 ID(멘션용), "Discord로도 받기", Webhook 미설정 안내, 테스트 알림.
import { useState } from "react";
import { useTestNotification, useUpdateNotificationSettings } from "../../api/autotrade";
import { errorMessage } from "../../api/client";
import { useNotificationSettings } from "../../api/queries";
import type { NotificationSettings } from "../../api/types";
import { checkDiscordId } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { Icon } from "../Icon";
import { useToast } from "../toast";
import { Card, ErrorState, Notice, SkeletonCard, Spinner } from "../ui";

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
            onSuccess: (n) => toast(n.discordUserId ? "Discord 사용자 ID를 저장했습니다. 알림에 멘션합니다." : "Discord 사용자 ID를 지웠습니다."),
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
          value={raw}
          maxLength={24}
          placeholder="숫자 17~20자리"
          onChange={(e) => setRaw(e.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={showError ? true : undefined}
          aria-describedby="discord-id-help discord-id-error"
          className={cn(
            "h-12 min-w-0 flex-1 rounded-xl bg-fill px-3.5 text-[16px] tabular-nums outline-none focus:ring-2 focus:ring-brand",
            showError && "ring-2 ring-up",
          )}
        />
        <button
          type="submit"
          disabled={!changed || update.isPending}
          className="flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
        >
          {update.isPending && <Spinner />}
          저장
        </button>
      </div>
      {showError && (
        <p id="discord-id-error" role="alert" className="text-[13px] font-medium text-up">
          {check.error}
        </p>
      )}
      <p id="discord-id-help" className="text-[13px] leading-relaxed text-mute">
        넣어 두면 Discord 알림에 나를 멘션합니다. 비우고 저장하면 지웁니다. 찾는 법: Discord 설정 → 고급 → 개발자 모드 켜기 → 내 프로필 우클릭 → ID 복사
      </p>
    </form>
  );
}

function DiscordToggle({ s }: { s: NotificationSettings }) {
  const toast = useToast();
  const update = useUpdateNotificationSettings();
  // 누르자마자 바뀐 상태를 보여 주고, 실패하면 되돌린다
  const [checked, setChecked] = useState(s.discordEnabled);
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
      <span>
        <span className="block text-[16px] font-semibold">Discord로도 받기</span>
        <span className="block text-[13px] text-mute">웹 알림은 항상 남습니다.</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={update.isPending}
        onChange={(e) => {
          const on = e.target.checked;
          setChecked(on);
          update.mutate(
            { discordEnabled: on },
            {
              onSuccess: (n) => toast(n.discordEnabled ? "알림을 Discord로도 보냅니다." : "Discord로는 보내지 않습니다 (웹 알림만)."),
              onError: (err) => {
                setChecked(!on);
                toast(errorMessage(err), "error");
              },
            },
          );
        }}
        className="size-6 cursor-pointer accent-brand"
      />
    </label>
  );
}

export function NotificationSettingsCard() {
  const toast = useToast();
  const { data: s, isPending, isError, error, refetch } = useNotificationSettings();
  const test = useTestNotification();
  if (isPending) return <SkeletonCard lines={4} />;
  if (isError) {
    return (
      <Card>
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      </Card>
    );
  }
  return (
    <Card aria-labelledby="noti-settings-title" className="space-y-4">
      <h2 id="noti-settings-title" className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="bell" className="size-5" />
        알림 설정
      </h2>
      {!s.webhookConfigured && <Notice tone="warn">서버에 Discord Webhook이 설정되지 않아 웹 알림만 갑니다.</Notice>}
      <DiscordToggle key={`t-${s.discordEnabled}`} s={s} />
      <div className="border-t border-line pt-4">
        <DiscordIdForm key={s.discordUserId ?? ""} s={s} />
      </div>
      <button
        type="button"
        disabled={test.isPending}
        onClick={() =>
          test.mutate(undefined, {
            onSuccess: (r) => toast(r.detail),
            onError: (err) => toast(errorMessage(err), "error"),
          })
        }
        className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-fill text-[15px] font-semibold text-ink hover:bg-line disabled:opacity-40"
      >
        {test.isPending ? <Spinner /> : <Icon name="bell" className="size-4" />}
        테스트 알림 보내기
      </button>
    </Card>
  );
}
