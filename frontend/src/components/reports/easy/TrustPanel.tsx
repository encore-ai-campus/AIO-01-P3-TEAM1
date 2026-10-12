// 신뢰 패널 (docs/plans/컨셉변경계획.md 5장·6장): 1줄 검토 통과 · 인용 수 · 자료 기준 시각, 2줄(있을 때만) 자동 복구 문장.
// 작은 글씨 "AI 검토는 사실을 보증하지 않아요"(꼭 읽어야 하는 문장이라 보조 글자색). 점수·고쳐 쓴 횟수는 펼친 곳에 (쉬운 보기에서 점수로 오해하지 않게).
// 펼침은 네이티브 details (index.css가 내용이 부드럽게 나타나게 한다). 열림 표시는 오른쪽 chevron이 돈다.
// 쉬운 PDF(backend/reports/output/easy_text.py trust_lines)도 같은 문장을 쓴다 — 바꾸면 둘 다 고친다
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
      <p className="text-[12px] text-sub">{AI_REVIEW_NOTE}</p>
      <details className="group/trust text-[13px]">
        {/* 보이는 높이는 36px, 누르는 곳은 위아래 4px씩 넓혀 44px */}
        <summary className="relative -ml-1 inline-flex min-h-9 cursor-pointer list-none items-center gap-0.5 rounded-md px-1 font-semibold text-brand-ink select-none before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-line/60">
          검토 자세히
          <Icon name="chevron-down" className="size-4 transition-transform duration-fast group-open/trust:rotate-180" />
        </summary>
        <p className="text-sub tabular-nums">
          검토 점수 {trust.score === null ? "-" : `${trust.score}점`} · 고쳐 쓴 횟수 {trust.rewrites}번
        </p>
      </details>
    </section>
  );
}
