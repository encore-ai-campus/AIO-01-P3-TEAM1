"""매매 종목 선정 팀(stock_selection) Worker 등록과 다섯 Worker가 같이 쓰는 도구 (docs/design/AI_AGENT_WORKFLOW.md 2~4장).

후보 표는 규칙 선별이 실행 시작 때 한 번 만들어 `ctx.team_inputs["candidates"]`로 준다 (reports.autoreport.selection.team_inputs).
항목은 선별 파일의 pick 그대로(snake_case): symbol, name, score, close, rsi, atr_ratio, change20d, trading_amount,
tradingAmountRank, origin. 후보 표가 없으면 다섯 Worker 모두 WorkerError(NO_CANDIDATES).

조사 Worker(뉴스·공시·수급)는 후보마다 자료를 모은다. 단계 제한 시간(ctx.deadline, healing.clock 기준)이
FETCH_RESERVE_SEC 이하로 남으면 조회를 멈추고 남은 후보는 "자료 없음"으로 LLM에 넘긴다 (LLM 호출 한 번에 쓸 시간을 남긴다).
조회 하나도 그 남은 몫 안에서만 기다린다 (DART는 요청 하나가 60초까지 걸릴 수 있다 — 넘기면 그 후보는 "자료 없음"이고 조회를 멈춘다).
선정 팀 프롬프트·선정안에는 가격·증권사 목표가를 두지 않는다 (TABLE_KEYS와 같은 원칙, 2026-10-12): 선정·검토에 주는 조사 결과는
가격을 "(가격)"으로 가린 사본이고(research_sections), 가격이 든 글은 has_price로 찾는다 (docs/DECISIONS.md 30장).
"""
import logging
import re
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

# 가격 모양: "70,000원"·"70000원"·"7만 2천원"·"8.5만원", 가격 낱말 뒤의 숫자("목표가 9만", "주가 950"), 달러("$185"·"185달러").
# "1조원 수주"·"500억원"·"3억5000만원"처럼 금액은 걸리지 않는다. 가격 낱말 뒤의 등락률·기간·날짜·순위·금액·개수("주가 3.18% 하락",
# "주가 3주 연속", "주가 10월 들어", "매수가 1,200억원", "외국인 매도가 12만주")도 가격이 아니다. 앞에 한글이 붙은 낱말("수주가 3.9조",
# "순매수가 120만주", "주주가 3명")과 회사 목표("판매 목표가 400만대")는 가격 낱말이 아니다 (2026-10-12, docs/DECISIONS.md 30장)
_COUNT = r"억|주|명|건|개|곳|차례|번|배"   # 만·천 뒤에서도 가격이 아니게 하는 단위 ("120만주"·"120만 주"·"3천억원")
# 가격 낱말 뒤 숫자의 뒤가 이것이면 가격이 아니다. _COUNT 말고는 숫자 바로 뒤에서만 본다 ("주가 7만 위로"는 가격)
_NOT_PRICE = rf"(?![\d.,]*\s*(?:%|일|거래일|영업일|개월|년|월|분|위|조|(?:천\s*만|만|천)?\s*(?:{_COUNT})))"
_WORD = r"(?<![가-힣])(?:주가|현재가|종가)"   # 수주가·대주주가·자사주가는 아니다
_TRADE = r"(?<![가-힣])(?:매수|매도)"         # 순매수가·공매도가·공개매수가는 아니다 ("공개매수가 2만원"은 맨 가격으로 걸린다)
_GOAL = r"(?<!수주 )(?<!매출 )(?<!판매 )(?<!생산 )목표"   # 회사 목표(수주·매출·판매·생산 목표)의 "목표가"는 증권사 목표가가 아니다
_NOT_AFTER_EOK = r"(?<![\d.,억])(?<!억\s)"   # 억 뒤의 "…만원"은 금액이다 ("3억5000만원"). 숫자 중간에서도 시작하지 않는다
_LABEL = rf"(?:{_GOAL}|적정|진입|손절|{_TRADE})\s*주?\s*가(?:격)?|{_WORD}"   # 가격 낱말 (PRICE와 mask_prices가 같이 쓴다)
PRICE = re.compile(
    r"\d{1,3}(?:,\d{3})+\s*원|\d{4,}\s*원"
    rf"|{_NOT_AFTER_EOK}\d+(?:\.\d+)?\s*만\s*(?:\d+\s*천\s*)?원"
    rf"|(?:{_LABEL})\s*(?:은|는|이|가|을|를|도|:)?\s*(?:약\s*)?\$?\s*\d{_NOT_PRICE}"
    r"|\$\s*\d|\d+(?:\.\d+)?\s*달러")
# 숫자 없는 증권사 목표가 낱말: "목표가 상향"·"목표가↑"·"목표주가"·"적정 주가"·"목표 가격".
# "목표 가동률"·"목표가치"·"목표가 아니다"·"수주 목표가 상향"(회사 목표)은 아니다
TARGET_WORD = re.compile(rf"(?:목표|적정)\s?주가|{_GOAL}(?:가(?![동치]|\s*아[니닌님])|\s가격)")
PRICE_TOKEN = "(가격)"  # mask_prices가 가격 자리에 넣는 표시
# mask_prices: 1단계는 가격 낱말 뒤의 가격("목표가 360,000원", "목표가 160만→260만"의 둘째 금액까지), 2단계는 맨 가격.
# 금액(6조7800억원·351억·1억 달러·120만주·3억5000만원)·종목 코드·날짜·등락률은 바꾸지 않는다 (가리는 기준은 PRICE와 같다)
_NUM = r"\d[\d,]*(?:\.\d+)?"
_MAN = r"\s*만(?:\s*\d+\s*천)?(?:\s*\d[\d,]*)?|\s*천(?:\s*\d+)?"   # "7만 2천"·"26만3000"·"5천"·"3천500"
_WON = r"\s*(?:원|달러)"
# 원·달러가 붙으면 가격. 아니면 뒤를 본다 (_NOT_PRICE와 같은 단위. 뒤가 만·천이면 덜 읽은 숫자라 가리지 않는다)
_AMOUNT = (rf"\$?\s*{_NUM}(?:(?:{_MAN})(?:{_WON}|(?!\s*(?:만|천|{_COUNT})|[\d.,]))"
           rf"|{_WON}|(?!\s*(?:%|일|거래일|영업일|개월|년|월|분|위|조|만|천|{_COUNT})|[\d.,]))")
_LABELED = re.compile(rf"((?:{_LABEL})\s*(?:은|는|이|가|을|를|도|:)?\s*(?:약\s*)?)({_AMOUNT})(?:(\s*(?:→|에서|~)\s*)({_AMOUNT}))?")
_BARE = re.compile(r"\d{1,3}(?:,\d{3})+\s*원|\d{4,}\s*원"
                   rf"|{_NOT_AFTER_EOK}\d+(?:\.\d+)?\s*만\s*(?:\d+\s*천\s*)?(?:\d[\d,]*\s*)?원"
                   r"|\$\s*\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s*달러")


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
    """앞 단계 조사 결과를 프롬프트 덩어리로 {제목: 결과 또는 None}. None은 user_prompt가 "자료 없음"으로 쓴다.

    결과 안의 글은 가격을 "(가격)"으로 가린 사본이다. 가리는 것은 프롬프트에 넣는 사본뿐이고 State의 조사 결과는 원문 그대로다.
    """
    return {title: _masked(inputs.get(worker_id)) for worker_id, title in RESEARCH.items()}


def has_price(text: str) -> bool:
    """글에 가격(PRICE)·숫자 없는 목표가 낱말(TARGET_WORD)·가린 가격 표시("(가격)")가 있나."""
    return bool(PRICE.search(text) or TARGET_WORD.search(text) or PRICE_TOKEN in text)


def mask_prices(text: str) -> str:
    """글의 가격을 "(가격)"으로 바꾼다: 가격 낱말 뒤의 가격(둘째 금액 "→260만"·"에서 260만"까지) → 맨 가격."""
    def labeled(m: re.Match) -> str:
        return m.group(1) + PRICE_TOKEN + (m.group(3) + PRICE_TOKEN if m.group(3) is not None else "")
    return _BARE.sub(PRICE_TOKEN, _LABELED.sub(labeled, text))


def _masked(value: Any) -> Any:
    """조사 결과의 글마다 mask_prices (목록·객체는 안쪽 값까지). 새 값을 만들고 받은 값은 고치지 않는다."""
    if isinstance(value, str):
        return mask_prices(value)
    if isinstance(value, list):
        return [_masked(item) for item in value]
    if isinstance(value, dict):
        return {key: _masked(item) for key, item in value.items()}
    return value


def changed_parts(before: dict | None, after: dict | None) -> dict[str, list[str]]:
    """두 선정안을 비교한다 → {"바뀜": [...], "그대로": [종목 코드 ...]}.

    "바뀜"은 종목 구성·순위가 다르면 "구성·순위", 두 선정안에 다 있는 종목의 글이 다르면 "<코드> reason"·"<코드> evidence",
    요약이 다르면 "summary". 둘 다 같은 종목은 "그대로"에 넣는다. 다시 하는 검토의 프롬프트와 선정 Worker의 `_changed`가 쓴다.
    """
    def picks(draft: dict | None) -> dict[str, dict]:
        return {str(pick.get("symbol")): pick for pick in (draft or {}).get("picks") or [] if isinstance(pick, dict)}
    old, new = picks(before), picks(after)
    same_ranks = {s: p.get("rank") for s, p in old.items()} == {s: p.get("rank") for s, p in new.items()}
    changed, same = ([] if same_ranks else ["구성·순위"]), []
    for symbol, pick in new.items():
        if symbol not in old:
            continue
        parts = [f"{symbol} {key}" for key in ("reason", "evidence") if old[symbol].get(key) != pick.get(key)]
        changed += parts
        if not parts:
            same.append(symbol)
    if (before or {}).get("summary") != (after or {}).get("summary"):
        changed.append("summary")
    return {"바뀜": changed, "그대로": same}


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
