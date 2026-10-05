// 근거 3 · 위험 3 (출처 표시) · 이 의견이 틀리는 경우 (docs/컨셉변경계획.md 5장).
// 근거 끝에 "(출처: …)"가 붙어 오면 근거마다 출처로 보이고, 리포트가 인용한 자료 목록(citations)은 아래에 한 번 보인다.
// "틀리는 경우": 손절 가격 조건은 코드가 만든 손절 문장이 맡고(화면 숫자는 코드가 만든다), AI 문장이 그 손절 가격만 말하면 숨기고
// 앞에 그 가격 조건이 붙어 있으면 떼어 다른 조건만 보인다 — 같은 뜻을 두 번 말하지 않게. 손절 가격과 다른 금액(환율·매출·다른 가격)은
// 다른 조건이라 원문 그대로 보인다. 긍정적이 아닌 의견에는 손절 가격이 없으므로 '손절'이 든 위험을 옮기지 않는다.
import type { Currency, ReportOpinion } from "../../../api/types";
import { formatPrice } from "../../../lib/format";
import { type DraftView, priceOnlyRisk, splitSource, validTargets, whenWrongOf, withoutPriceClause } from "../../../lib/reports";
import { Term } from "../../Term";
import { Card } from "../../ui";

function Lines({ label, lines, tone }: { label: string; lines: string[]; tone: "reason" | "risk" | "wrong" }) {
  const dot = tone === "reason" ? "bg-brand" : tone === "risk" ? "bg-warn" : "bg-up";
  return (
    <ul aria-label={label} className="space-y-2">
      {lines.map((line) => {
        const { text, source } = splitSource(line);
        return (
          <li key={line} className="flex gap-2 text-[15px] leading-snug">
            <span aria-hidden="true" className={`mt-2 size-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="min-w-0">
              {text}
              {source && <span className="mt-0.5 block text-[12px] text-mute">출처: {source}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ReasonsRisks({ draft, opinion, currency }: { draft: DraftView; opinion: ReportOpinion | null; currency: Currency }) {
  const { risk, others } = whenWrongOf(draft, opinion);
  const stopLine = opinion === "buy" && validTargets(draft.targets) ? draft.targets.stop : null;
  const riskText = risk === null ? null : splitSource(risk).text;
  // 손절 문장이 있으면 그 손절 가격만 말하는 AI 문장은 같은 뜻이라 숨긴다 (다른 금액·다른 조건이면 그대로 — 위험 목록에서 이미 옮겨 왔으므로 지우지 않는다)
  const wrong = riskText !== null && !(stopLine !== null && priceOnlyRisk(riskText, stopLine, currency)) ? riskText : null;
  return (
    <Card aria-labelledby="why-title" className="space-y-4">
      <h2 id="why-title" className="text-[17px] font-bold">
        근거와 위험
      </h2>
      <div>
        <h3 className="mb-1.5 text-[14px] font-bold text-sub">AI가 든 근거</h3>
        {draft.reasons.length ? <Lines label="근거" lines={draft.reasons} tone="reason" /> : <p className="text-[14px] text-mute">근거가 없어요.</p>}
      </div>
      <div>
        <h3 className="mb-1.5 text-[14px] font-bold text-sub">위험</h3>
        {others.length ? <Lines label="위험" lines={others} tone="risk" /> : <p className="text-[14px] text-mute">따로 적은 위험이 없어요.</p>}
      </div>
      <div>
        <h3 className="mb-1.5 text-[14px] font-bold text-sub">이 의견이 틀리는 경우</h3>
        <ul aria-label="이 의견이 틀리는 경우" className="space-y-2 rounded-xl bg-fill px-3.5 py-3 text-[15px] leading-snug">
          {stopLine !== null && (
            <li>
              가격이 <Term k="손절">손절 가격</Term>({formatPrice(stopLine, currency)}) 아래로 내려가면 이 의견을 다시 봐야 해요
            </li>
          )}
          {/* 손절 문장이 가격을 말하므로 AI 문장 앞의 같은 손절 가격 조건은 떼고 다른 조건만 (같은 가격을 두 번 보이지 않게) */}
          {wrong && <li>{stopLine !== null ? withoutPriceClause(wrong, stopLine, currency) : wrong}</li>}
          {stopLine === null && !wrong && <li>AI가 근거로 든 내용(실적·공시·수급)이 바뀌면 의견도 달라질 수 있어요</li>}
        </ul>
      </div>
      {draft.citations.length > 0 && (
        <p className="text-[13px] leading-snug text-sub">
          이 리포트가 인용한 자료 {draft.citations.length}개: {draft.citations.join(" · ")}
        </p>
      )}
    </Card>
  );
}
