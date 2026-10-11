"""매매 종목 선정 팀(stock_selection) Worker 등록과 다섯 Worker가 같이 쓰는 도구 (docs/design/AI_AGENT_WORKFLOW.md 2~4장).

후보 표는 규칙 선별이 실행 시작 때 한 번 만들어 `ctx.team_inputs["candidates"]`로 준다 (reports.autoreport.selection.team_inputs).
항목은 선별 파일의 pick 그대로(snake_case): symbol, name, score, close, rsi, atr_ratio, change20d, trading_amount,
tradingAmountRank, origin. 후보 표가 없으면 다섯 Worker 모두 WorkerError(NO_CANDIDATES).

조사 Worker(뉴스·공시·수급)는 후보마다 자료를 모은다. 단계 제한 시간(ctx.deadline, healing.clock 기준)이
FETCH_RESERVE_SEC 이하로 남으면 조회를 멈추고 남은 후보는 "자료 없음"으로 LLM에 넘긴다 (LLM 호출 한 번에 쓸 시간을 남긴다).
조회 하나도 그 남은 몫 안에서만 기다린다 (DART는 요청 하나가 60초까지 걸릴 수 있다 — 넘기면 그 후보는 "자료 없음"이고 조회를 멈춘다).
"""
import logging
import threading
from collections.abc import Callable
from typing import Any

from ...guardrails import contracts
from ...autohealing import healing
from ..base import Worker, WorkerContext, WorkerError
from ..prompts import NO_DATA

log = logging.getLogger(__name__)

NO_CANDIDATES = "오늘의 후보 표가 없습니다"
FETCH_RESERVE_SEC = 70  # 남은 시간이 이만큼 이하면 자료 조회를 멈춘다 (LLM 호출 몫 — 호출 한 번 60초 + 여유)
# 선정·검토 프롬프트에 넣는 후보 표 열 — 코드가 계산한 값만. 가격(close)·증권사 글(title·targetPrice)은 넣지 않는다
TABLE_KEYS = ("symbol", "name", "score", "rsi", "atr_ratio", "change20d", "trading_amount", "tradingAmountRank",
              "origin")
# 선정·검토가 보는 조사 결과 (Worker id → 프롬프트 제목). 없는 결과는 "자료 없음"
RESEARCH = {
    "news_screen_agent": "뉴스 점검 결과 (news_screen_agent)",
    "filing_screen_agent": "공시 점검 결과 (filing_screen_agent)",
    "flow_agent": "수급 해석 결과 (flow_agent, 선택 — 실패하면 자료 없음)",
}


def candidates_of(ctx: WorkerContext) -> list[dict]:
    """오늘의 후보 표 (규칙 점수 순, 최대 contracts.MAX_CANDIDATES개). 없거나 비면 WorkerError."""
    rows = (ctx.team_inputs or {}).get("candidates") or []
    rows = [row | {"symbol": str(row["symbol"]).strip()} for row in rows
            if isinstance(row, dict) and str(row.get("symbol") or "").strip()]
    if not rows:
        raise WorkerError(NO_CANDIDATES)
    return rows[:contracts.MAX_CANDIDATES]


def market_of(ctx: WorkerContext) -> str:
    """후보 표의 시장 ("KR" | "US"). team_inputs에 없으면 리포트의 시장."""
    return str((ctx.team_inputs or {}).get("market") or ctx.market or "KR").upper()


def candidate_table(rows: list[dict]) -> list[dict]:
    """프롬프트용 후보 표: TABLE_KEYS 중 값이 있는 것만."""
    return [{key: row[key] for key in TABLE_KEYS if row.get(key) is not None} for row in rows]


def research_sections(inputs: dict[str, dict]) -> dict[str, Any]:
    """앞 단계 조사 결과를 프롬프트 덩어리로 {제목: 결과 또는 None}. None은 user_prompt가 "자료 없음"으로 쓴다."""
    return {title: inputs.get(worker_id) for worker_id, title in RESEARCH.items()}


def fetch_budget(ctx: WorkerContext) -> float:
    """자료 조회에 더 쓸 수 있는 초: 단계 제한 시간까지 남은 시간에서 LLM 몫(FETCH_RESERVE_SEC)을 뺀 것."""
    return ctx.deadline - healing.clock() - FETCH_RESERVE_SEC


def can_fetch(ctx: WorkerContext) -> bool:
    """조회를 하나 더 해도 되나: 단계 제한 시간까지 FETCH_RESERVE_SEC보다 많이 남았을 때만."""
    return fetch_budget(ctx) > 0


def bounded(fetch: Callable[[dict], Any], row: dict, limit: float) -> Any:
    """fetch(row)를 데몬 스레드에서 돌려 limit초까지만 기다린다. 넘기면 TimeoutError (스레드는 혼자 끝난다)."""
    box: dict[str, Any] = {}

    def work() -> None:
        try:
            box["value"] = fetch(row)
        except Exception as e:  # noqa: BLE001 — 부른 쪽에 그대로 넘긴다
            box["error"] = e

    thread = threading.Thread(target=work, name=f"fetch-{row.get('symbol')}", daemon=True)
    thread.start()
    thread.join(max(limit, 0.0))
    if thread.is_alive():
        raise TimeoutError(f"{limit:.0f}초 안에 응답이 없습니다")
    if "error" in box:
        raise box["error"]
    return box.get("value")


def gather(ctx: WorkerContext, rows: list[dict], fetch: Callable[[dict], Any]) -> dict[str, Any]:
    """후보마다 fetch(후보)를 차례로 부른다 → {symbol: 자료}. 실패했거나 시간이 모자라 부르지 않은 후보는 NO_DATA."""
    found: dict[str, Any] = {}
    for row in rows:
        symbol = row["symbol"]
        if not can_fetch(ctx):
            found[symbol] = NO_DATA
            continue
        try:
            found[symbol] = bounded(fetch, row, fetch_budget(ctx))
        except Exception as e:  # 후보 하나의 조회 실패는 그 후보만 "자료 없음"
            log.warning("%s: %s 자료 조회 실패 (%s: %s)", ctx.worker_id, symbol, type(e).__name__, e)
            found[symbol] = NO_DATA
    skipped = sum(1 for row in rows if found[row["symbol"]] == NO_DATA)
    if skipped:
        log.info("%s: 후보 %d개 중 %d개는 자료 없음으로 넘긴다", ctx.worker_id, len(rows), skipped)
    return found


def _workers() -> dict[str, Worker]:
    # Worker 모듈이 이 파일의 도구를 가져다 쓰므로 등록은 도구를 다 정의한 뒤 (순환 import를 피한다)
    from .filing_screen import FilingScreenAgent
    from .flow import FlowAgent
    from .news_screen import NewsScreenAgent
    from .selection_review import SelectionReviewAgent
    from .selector import SelectorAgent

    workers = (NewsScreenAgent(), FilingScreenAgent(), FlowAgent(), SelectorAgent(), SelectionReviewAgent())
    return {worker.id: worker for worker in workers}


WORKERS: dict[str, Worker] = _workers()
