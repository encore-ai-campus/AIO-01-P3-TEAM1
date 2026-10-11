"""리스크 점검 Worker `risk_agent` (docs/tasks/02-worker.md T2-7). 검토가 넘긴 Handoff로만 불린다.

자료: 증권사 매수 유의 지정(`trading.market.warnings` — 투자경고 등 한국어 이름), Handoff 전달 데이터, 지금까지의 결과 전부.
결정론적 바닥: 지정이 하나라도 있으면 level은 medium 이상, 투자경고·투자위험·거래정지·정리매매·관리종목이면 high.
지정 이름은 warnings·flags 맨 앞에 코드가 넣는다 (Orchestrator가 리포트 맨 위 경고 블록으로 쓴다). level이 추천의 "리스크 단계"가 된다.
"""
from trading import market

from config.api import Unavailable

from ...guardrails.contracts import RISK_LEVELS
from ..base import WorkerContext
from ..prompts import system_prompt, user_prompt

# 지정만으로 high인 유형 (거래 자체가 막히거나 상장 유지가 불확실한 것)
HIGH_WARNING_TYPES = ("INVESTMENT_WARNING", "INVESTMENT_RISK", "TRADING_SUSPENDED", "LIQUIDATION_TRADING",
                      "ADMINISTRATIVE_ISSUE")
HIGH_WARNINGS = frozenset(market.WARNING_LABELS[t] for t in HIGH_WARNING_TYPES)
MAX_FLAGS, MAX_WARNINGS = 10, 5   # RiskResult 상한
UNKNOWN_WARNING = "투자유의 지정 여부를 확인하지 못했어요"
PROMPT_RESULTS = {"market_agent": "시세·차트 조사", "fundamental_agent": "재무·공시 조사", "news_agent": "뉴스·심리 조사",
                  "report_agent": "리포트 초안", "review_agent": "검토 결과"}

ROLE = ("너는 모의투자 서비스 '모매매'의 AI 리포트 팀에서 리스크 점검을 맡은 AI다. "
        "검토 AI가 넘긴 책임을 받아 투자유의 지정과 고위험 신호를 점검하고 리포트 맨 위에 붙일 경고를 쓴다.")
RULES = """- level은 low·medium·high 중 하나다. 투자유의 지정이 하나라도 있으면 medium 이상, 투자경고·투자위험·거래정지·정리매매·관리종목이면 high다 (코드가 다시 확인한다).
- 큰 변동성(volatilityPct), 급한 등락, 부정적인 공시·뉴스, 초안의 손절 가격까지의 거리도 본다.
- flags는 짧은 위험 표시(예: "투자경고", "변동성 큼"), warnings는 리포트 맨 위에 보일 경고 문장(최대 5개), summary는 두세 문장이다.
- 매수·매도를 권하지 않는다. 위험을 사실대로 알린다."""


class RiskAgent:
    id = "risk_agent"
    output_contract = "RiskResult"

    def run(self, ctx: WorkerContext) -> dict:
        labels = warning_labels(ctx.symbol)
        sections = {
            "종목": {"symbol": ctx.symbol, "name": ctx.name, "market": ctx.market},
            "투자유의 지정 (코드 조회)": labels_text(labels),
            "넘겨받은 책임 (Handoff)": handoff_view(ctx),
        }
        sections |= {f"{title} ({wid})": ctx.inputs.get(wid) for wid, title in PROMPT_RESULTS.items()}
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), user_prompt(sections),
                        contract=self.output_contract)
        return finish(reply.data, labels)


def warning_labels(symbol: str) -> list[str] | None:
    """매수 유의 지정 이름 목록 (없으면 []). 증권사 조회가 안 되면 None (모름 — 지정이 없다는 뜻이 아니다)."""
    try:
        return list(market.warnings(symbol))
    except Unavailable:
        return None


def labels_text(labels: list[str] | None) -> str:
    if labels is None:
        return "확인하지 못함 (증권사 조회 실패)"
    return ", ".join(labels) if labels else "지정 없음"


def level_floor(labels: list[str] | None) -> str:
    """지정으로 정해지는 가장 낮은 level: 없으면(또는 모르면) low, 지정이 있으면 medium, 고위험 지정이면 high."""
    if not labels:
        return "low"
    return "high" if any(label in HIGH_WARNINGS for label in labels) else "medium"


def finish(answer: dict, labels: list[str] | None) -> dict:
    """level을 지정 바닥 이상으로 올리고, 지정 이름을 warnings·flags 맨 앞에 둔다."""
    result = dict(answer)
    floor = level_floor(labels)
    if RISK_LEVELS.index(result["level"]) < RISK_LEVELS.index(floor):
        result["level"] = floor
    if labels:
        lead_warnings, lead_flags = [f"투자유의 지정: {label}" for label in labels], list(labels)
    else:
        lead_warnings, lead_flags = ([UNKNOWN_WARNING] if labels is None else []), []
    result["warnings"] = _merge(lead_warnings, result.get("warnings"))[:MAX_WARNINGS]
    result["flags"] = _merge(lead_flags, result.get("flags"))[:MAX_FLAGS]
    return result


def handoff_view(ctx: WorkerContext) -> dict | None:
    """Handoff 전달 데이터에서 프롬프트에 넣을 것만 (목표·제약·기대 출력·넘긴 이유). 사용자 아이디·task id는 넣지 않는다."""
    review = ctx.inputs.get("review_agent") or {}
    reason = (review.get("handoff") or {}).get("reason")
    payload = ctx.handoff or {}
    view = {"objective": payload.get("objective"), "constraints": payload.get("constraints"),
            "expectedOutput": payload.get("expected_output"), "reason": reason}
    return {k: v for k, v in view.items() if v} or None


def _merge(lead: list[str], rest) -> list[str]:
    return list(dict.fromkeys([*lead, *[item for item in rest or [] if isinstance(item, str) and item.strip()]]))
