"""수급 해석 Worker `flow_agent` (선택) → FlowResult (docs/design/AI_AGENT_WORKFLOW.md 2장).

후보마다 투자자별 매매동향(client.investor_trading, 국내만)을 받아 **코드가** 외국인·기관 순매수 수량을 최근 5일·20일로 더한다.
LLM은 그 합계 표만 보고 해석(signal·note)한다 — 숫자를 다시 계산하지 않는다.
조회 클라이언트가 없거나 국내 시장이 아니면 WorkerError (선택 Worker라 팀은 수급 없이 계속한다).
조회가 실패한 후보는 표에서 빠지고, 결과도 표에 있는 종목만 남긴다.
"""
import math

from ..base import WorkerContext, WorkerError
from ..prompts import system_prompt, user_prompt
from .team import candidates_of, gather, market_of

FLOW_DAYS = 20
WINDOWS = (5, 20)  # 합계를 내는 최근 거래일 수
INVESTORS = ("foreigner", "institution")

ROLE = """너는 매매 후보 종목의 수급(외국인·기관 순매수)을 해석하는 담당이다.
코드가 더한 순매수 합계 표를 보고 후보마다 매집·이탈 여부를 한 줄로 해석한다."""

RULES = """- 표의 숫자는 코드가 더한 순매수 수량(주)이다. + 는 순매수, - 는 순매도. 다시 계산하거나 새 숫자를 만들지 않는다.
- signal: accumulating = 외국인·기관이 최근 5일과 20일 모두 대체로 사들임, distributing = 대체로 팔고 있음,
  mixed = 투자자나 기간에 따라 엇갈리거나 판단이 어려움.
- note에는 한 줄 해석을 쓴다 (예: "외국인은 5일·20일 모두 순매수, 기관은 20일 순매도로 엇갈림").
- 표에 있는 종목만, 종목마다 items 하나를 쓴다. symbol은 표의 코드를 그대로 쓴다.
- summary는 후보 전체의 수급 흐름을 2~3문장으로 쓴다."""


class FlowAgent:
    id = "flow_agent"
    output_contract = "FlowResult"

    def run(self, ctx: WorkerContext) -> dict:
        rows = candidates_of(ctx)
        client = ctx.client
        if client is None:
            raise WorkerError("수급 조회 불가")
        if market_of(ctx) != "KR":
            raise WorkerError("수급은 국내 종목만 조회할 수 있습니다")
        found = gather(ctx, rows, lambda row: client.investor_trading(row["symbol"], count=FLOW_DAYS))
        table = [entry for row in rows if (entry := flow_sums(row, found[row["symbol"]])) is not None]
        if not table:
            raise WorkerError("수급 자료가 없습니다")
        title = f"후보별 외국인·기관 순매수 합계 (주, 최근 {WINDOWS[0]}·{WINDOWS[1]}거래일, 코드가 더한 값)"
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), user_prompt({title: table}),
                        contract=self.output_contract)
        shown = {entry["symbol"] for entry in table}
        return {"summary": reply.data["summary"],
                "items": [item for item in reply.data["items"] if item["symbol"] in shown]}


def flow_sums(row: dict, history) -> dict | None:
    """investor_trading 행들 → {symbol, name, days, net5d, net20d}. 더할 숫자가 하나도 없으면 None.

    net{n}d = {"foreigner", "institution", "sum"}: 최근 n거래일 순매수 수량의 합 (값이 없는 날은 빼고, 전부 없으면 None).
    """
    if not isinstance(history, list):
        return None
    days = sorted((r for r in history if isinstance(r, dict)), key=lambda r: str(r.get("date") or ""), reverse=True)
    entry: dict = {"symbol": row["symbol"], "name": row.get("name"), "days": len(days)}
    for window in WINDOWS:
        totals = {investor: _total(days[:window], investor) for investor in INVESTORS}
        known = [value for value in totals.values() if value is not None]
        entry[f"net{window}d"] = totals | {"sum": _whole(sum(known)) if known else None}
    if all(entry[f"net{window}d"]["sum"] is None for window in WINDOWS):
        return None
    return entry


def _total(days: list[dict], investor: str) -> int | float | None:
    values = [value for day in days if (value := _net(day.get(investor))) is not None]
    return _whole(sum(values)) if values else None


def _net(entry) -> float | None:
    """{"netBuyVolume": "-90"} → -90.0. 없거나 숫자가 아니면 None."""
    if not isinstance(entry, dict):
        return None
    try:
        value = float(entry.get("netBuyVolume"))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _whole(value: float) -> int | float:
    return int(value) if float(value).is_integer() else value
