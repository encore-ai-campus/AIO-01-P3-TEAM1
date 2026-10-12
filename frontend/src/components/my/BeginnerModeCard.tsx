// 마이 맨 위: 주린이모드 카드 (docs/plans/투자서비스확장계획.md 2-2 "맨 위에 주린이모드 스위치와 진단 결과").
// 스위치(계정에 저장 — 기기를 바꿔도 같고 웹 알림 문장도 이 모드를 따른다) → 바뀌는 모습 예시 → 투자 성향·경험 진단.
// 같은 값을 바꾸는 두 조작(스위치·'추천대로')을 한 카드에 둬서 '추천 → 적용 → 스위치가 바뀜'이 한눈에 이어진다.
// 켜기는 바로, 끄기는 한 줄 확인("어려운 용어·숫자가 그대로 나와요") 뒤에 한다. 확인은 한 번에 하나만 열린다 (스위치 쪽 또는 추천 쪽).
import { useState } from "react";
import { useBeginnerMode } from "../../hooks/useBeginnerMode";
import { cn } from "../../lib/cn";
import { Collapse } from "../motion/Collapse";
import { Card, Switch } from "../ui";
import { ConfirmOff } from "./ConfirmOff";
import { InvestorDiagnosis } from "./InvestorDiagnosisCard";
import { useApplyBeginnerMode } from "./useApplyBeginnerMode";

const SWITCH_ID = "beginner-switch";

/** 켬·끔에 따라 같은 계획이 어떻게 보이는지 (docs/plans/컨셉변경계획.md 4-4 용어 표). 손익비 기준값은 쓰지 않는다. */
const EXAMPLES = [
  { on: true, label: "켬", text: "목표에 팔면 +12% · 손절에 팔면 −4%" },
  { on: false, label: "끔", text: "목표가 +12% · 손절가 −4%" },
] as const;

function ModeExample({ beginnerMode }: { beginnerMode: boolean }) {
  return (
    <div className="mt-3">
      <ul aria-label="화면에 나오는 말 예시" className="space-y-1 text-[14px]">
        {EXAMPLES.map((x) => {
          const now = x.on === beginnerMode;
          return (
            <li key={x.label} aria-current={now ? "true" : undefined} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn("size-1.5 shrink-0 rounded-full transition-colors duration-fast", now ? "bg-brand" : "bg-line")}
              />
              <span className={cn("w-5 shrink-0 font-semibold transition-colors duration-fast", now ? "text-brand-ink" : "text-mute")}>{x.label}</span>
              <span className={cn("min-w-0 transition-colors duration-fast", now ? "font-semibold text-ink" : "text-mute")}>{x.text}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[12px] leading-snug text-mute">리포트 화면의 &lsquo;이 화면만 자세히 보기&rsquo;는 이 설정을 바꾸지 않아요.</p>
    </div>
  );
}

export function BeginnerModeCard({ diagnosisId, diagnosisLit = false }: { diagnosisId?: string; diagnosisLit?: boolean }) {
  const { beginnerMode } = useBeginnerMode();
  const { apply, isPending } = useApplyBeginnerMode();
  const [confirm, setConfirm] = useState<"switch" | "recommend" | null>(null);
  // 이미 꺼졌으면(다른 곳에서 바꿈) 확인은 의미가 없다
  const asking = beginnerMode ? confirm : null;

  // 누른 버튼이 사라지거나 확인을 닫으면 포커스를 스위치로 돌려준다 (키보드·화면 읽기 사용자가 자리를 잃지 않게)
  const focusSwitch = () => document.getElementById(SWITCH_ID)?.focus({ preventScroll: true });
  const turnOn = () => {
    setConfirm(null);
    apply(true);
  };
  const confirmOff = () => {
    setConfirm(null);
    apply(false);
    focusSwitch();
  };
  const cancelFromSwitch = () => {
    setConfirm(null);
    focusSwitch();
  };

  return (
    <Card aria-labelledby="beginner-title">
      <Switch
        id={SWITCH_ID}
        checked={beginnerMode}
        busy={isPending}
        // 저장 중에도 막지(disabled) 않는다: 막으면 포커스가 body로 떨어진다. 대신 손잡이 스피너를 보이고 누름을 무시한다
        onChange={(on) => {
          if (isPending) return;
          if (on) turnOn();
          else setConfirm("switch");
        }}
        className="min-h-11"
        label={
          <span className="block">
            <span id="beginner-title" role="heading" aria-level={2} className="block text-[17px] font-bold">
              주린이모드
            </span>
            <span className="mt-0.5 block text-[13px] leading-snug text-sub">
              <b className={cn("font-semibold transition-colors duration-fast", beginnerMode ? "text-brand-ink" : "text-ink")}>
                {beginnerMode ? "켬" : "끔"}
              </b>
              {beginnerMode ? " · 쉬운 말과 꼭 필요한 숫자만 보여요" : " · 원래 용어와 숫자를 그대로 보여요"}
            </span>
          </span>
        }
      />
      <Collapse open={asking === "switch"}>
        <div className="pt-3">
          <ConfirmOff busy={isPending} onConfirm={confirmOff} onCancel={cancelFromSwitch} />
        </div>
      </Collapse>
      <ModeExample beginnerMode={beginnerMode} />
      <div className="mt-4 border-t border-line pt-3">
        <InvestorDiagnosis
          anchorId={diagnosisId}
          lit={diagnosisLit}
          confirming={asking === "recommend"}
          busy={isPending}
          onApplyOn={turnOn}
          onAskOff={() => setConfirm("recommend")}
          onConfirmOff={confirmOff}
          onCancelOff={() => setConfirm(null)}
          // 다시 진단을 열면 지금 결과에 대해 연 '추천대로 끄기' 확인을 닫는다 (스위치 쪽 확인은 그대로)
          onEdit={() => setConfirm((c) => (c === "recommend" ? null : c))}
        />
      </div>
    </Card>
  );
}
