// 시나리오 세 칸 (docs/plans/컨셉변경계획.md 5장 — 화면 코드가 만든다, LLM 숫자 없음):
// 목표에 닿으면 +○원 · 손절에 닿으면 −○원 · 기간 안에 둘 다 안 닿으면 기간 끝날 때 가격으로 판다.
// 금액은 이 리포트 추천의 리스크 미리 보기(장마감 기준, 이 계좌로 계산한 수량)이고, 없거나 기한이 지났으면 1주 기준 비율(비용 전).
// 안전장치가 실행을 막은 계획이면 금액은 그대로 두고(막힌 이유 — 손익비 — 가 숫자로 보인다) '정했다'고 쓰지 않는다 (매매 계획 카드와 같은 말).
// 1주 기준 칸의 문장은 쉬운 PDF(backend/reports/output/easy_text.py SCENARIO_TEXT)도 같은 문장을 쓴다 — 바꾸면 둘 다 고친다
import type { Market } from "../../../api/types";
import { formatQty } from "../../../lib/format";
import type { ScenarioView } from "../../../lib/reports";
import { Term } from "../../Term";
import { AsOf, Card } from "../../ui";

function basisLine(s: ScenarioView): string {
  if (s.basis === "share") return "1주 기준 비율 · 수수료·세금 빼기 전";
  if (s.blocked) return `이 계획의 수량(${formatQty(s.quantity)})으로 계산 · 수수료·세금 반영 — 지금은 안전장치가 실행을 막았어요`;
  return `안전장치가 이 계좌로 정한 ${formatQty(s.quantity)} 기준 · 수수료·세금 반영`;
}

export function ScenarioBoxes({ scenario, market }: { scenario: ScenarioView; market: Market }) {
  const account = scenario.basis === "account";
  return (
    <Card aria-labelledby="scenario-title">
      <h2 id="scenario-title" className="text-[17px] font-bold">
        세 가지 경우
      </h2>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] leading-snug text-sub">
        {basisLine(scenario)}
        {account && <AsOf at={scenario.asOf} market={market} />}
      </p>
      {/* 이익·손실 상자는 매매 계획 카드와 같은 바탕 (같은 뜻은 같은 색) */}
      <ul aria-label="세 가지 경우" className="mt-3 grid gap-2 sm:grid-cols-3">
        <li className="rounded-xl bg-up-soft px-3.5 py-3">
          <p className="text-[14px] font-semibold text-sub">
            <Term k="목표 가격" />에 닿으면
          </p>
          <p className="mt-1 text-[20px] font-bold text-up tabular-nums">{scenario.gain}</p>
          <p className="mt-0.5 text-[13px] leading-snug text-sub">모의 계좌에서 팔아요</p>
        </li>
        <li className="rounded-xl bg-down-soft px-3.5 py-3">
          <p className="text-[14px] font-semibold text-sub">
            <Term k="손절">손절 가격</Term>에 닿으면
          </p>
          <p className="mt-1 text-[20px] font-bold text-down tabular-nums">{scenario.loss}</p>
          <p className="mt-0.5 text-[13px] leading-snug text-sub">손실이 더 커지지 않게 팔아요. 가격이 갑자기 크게 떨어지면 손실이 더 클 수도 있어요</p>
        </li>
        <li className="rounded-xl bg-fill px-3.5 py-3">
          <p className="text-[14px] font-semibold text-sub">기간 안에 둘 다 안 닿으면</p>
          <p className="mt-1 text-[20px] font-bold tabular-nums">{scenario.holdingDays ? `${scenario.holdingDays}거래일 뒤` : "기간 끝"}</p>
          <p className="mt-0.5 text-[13px] leading-snug text-sub">
            <Term k="보유 기간" />이 끝나는 날 가격에 팔아요. 이익일 수도, 손실일 수도 있어요
          </p>
        </li>
      </ul>
      {!account && (
        <p className="mt-2 text-[13px] text-sub">
          {scenario.expired ? "계획 기한이 끝나 계좌 금액 대신 비율로 보여요." : "이 리포트의 모의 자동매매 계획이 아직 없어 계좌 금액 대신 비율로 보여요."}
        </p>
      )}
    </Card>
  );
}
