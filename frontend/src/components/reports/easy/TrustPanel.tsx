// 신뢰 패널 (docs/컨셉변경계획.md 5장·6장): 1줄 검토 통과 · 인용 수 · 자료 기준 시각, 2줄(있을 때만) 자동 복구 문장.
// 작은 글씨 "AI 검토는 사실을 보증하지 않아요". 점수·고쳐 쓴 횟수는 펼친 곳에 (쉬운 보기에서 점수로 오해하지 않게).
import { AI_REVIEW_NOTE } from "../../../lib/plainText";
import { type TrustInfo, dataTimeText } from "../../../lib/reports";
import { Icon } from "../../Icon";

export function TrustPanel({ trust }: { trust: TrustInfo }) {
  const first = [
    trust.reviewed ? "검토 AI가 근거와 대조해 통과" : "검토 기록이 없어요",
    `인용 ${trust.citations}개`,
    dataTimeText(trust.dataAt),
  ].join(" · ");
  return (
    <section aria-label="신뢰 정보" className="space-y-1 rounded-xl bg-fill px-3.5 py-3 text-[14px] leading-snug">
      <p className="flex items-start gap-1.5 font-semibold text-ink">
        <Icon name={trust.reviewed ? "check" : "alert"} className={trust.reviewed ? "mt-0.5 size-4 shrink-0 text-ok" : "mt-0.5 size-4 shrink-0 text-mute"} />
        {first}
      </p>
      {trust.rewrites > 0 && trust.reviewed && (
        <p className="text-sub">검토 AI가 근거가 약한 부분을 고쳐 쓰게 했고, 다시 검토해 통과했어요</p>
      )}
      {trust.recovery.map((line) => (
        <p key={line} className="flex items-start gap-1.5 text-sub">
          <Icon name="shield" className="mt-0.5 size-4 shrink-0 text-ok" />
          {line}
          {trust.reviewed && " — 검토는 똑같이 거쳤어요"}
        </p>
      ))}
      <p className="text-[12px] text-mute">{AI_REVIEW_NOTE}</p>
      <details className="text-[13px]">
        <summary className="inline-flex min-h-8 cursor-pointer items-center font-semibold text-brand select-none">검토 자세히</summary>
        <p className="text-sub tabular-nums">
          검토 점수 {trust.score === null ? "-" : `${trust.score}점`} · 고쳐 쓴 횟수 {trust.rewrites}번
        </p>
      </details>
    </section>
  );
}
