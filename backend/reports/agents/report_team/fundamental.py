"""재무·공시 Worker `fundamental_agent` (docs/tasks/02-worker.md T2-5).

자료: OpenDART 재무(`longterm.sources.fundamentals` — 하루 캐시)와 최근 30일 공시 목록(`DartClient.disclosures`).
국내 종목만 있다. DART 키가 없거나 조회가 실패·지연되면 "자료 없음"으로 LLM에 넘기고 metrics는 null이다 (Worker는 실패하지 않는다).
metrics(PER·PBR·ROE·매출 성장률·영업이익률)는 코드가 계산한 값으로 덮어쓰고, recentFilings는 받은 공시 목록에 있는 것만 남긴다.
공시 제목은 `guards.clean_text`를 거쳐 넣고, 지운 사유가 있으면 결과에 `_guarded`를 붙인다.
"""
import threading
import time
from datetime import timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone
from longterm import sources
from paper_engine.judge import fundamentals_check
from trading import market

from config.api import Unavailable

from ...autohealing import healing
from ...guardrails.guards import clean_text, merge_reasons
from ..base import WorkerContext
from ..prompts import NO_DATA, system_prompt, user_prompt

KST = ZoneInfo("Asia/Seoul")
DISCLOSURE_DAYS = 30
FILINGS_IN_PROMPT = 10
MAX_FILINGS = 5          # FundamentalResult.recentFilings 상한
MAX_EVIDENCE = 8
TITLE_MAX = 300          # 공시 제목·제출인 하나의 길이 상한
DATA_TIMEOUT_SEC = 30    # DART 조회(재무·공시 동시)를 기다리는 최대 시간 (엔진 DartClient는 호출마다 60초라 여기서 끊는다)
LLM_RESERVE_SEC = 100    # 단계 제한 시간 중 LLM 호출(재시도·대체 모델 포함)에 남겨 둘 시간
NOT_KR = "국내 종목만 DART 공시 자료가 있어요"
TOO_SLOW = "공시 자료를 제시간에 받지 못했어요"

ROLE = ("너는 모의투자 서비스 '모매매'의 AI 리포트 팀에서 재무·공시를 맡은 조사 AI다. "
        "DART 재무 자료와 최근 30일 공시 목록으로 실적의 흐름과 주요 사건을 정리한다.")
RULES = """- metrics의 per·pbr·roe·revenueGrowthPct·opMarginPct는 "코드가 계산한 지표" 값을 그대로 옮긴다 (퍼센트 단위). 재무 자료가 없으면 metrics는 null이다. 코드가 다시 덮어쓴다.
- recentFilings는 공시 목록에 있는 공시만 최대 5개다. 날짜와 제목은 목록 그대로 옮기고, impact는 positive·negative·neutral 중에서 고른다. 목록에 없는 공시를 만들지 않는다.
- 재무 자료가 없으면 summary에 재무 자료가 없다고 쓰고 실적을 추측하지 않는다.
- 매수·매도 의견은 내지 않는다 (의견은 작성 AI가 낸다).
- evidence에는 쓴 자료를 적는다 (예: "DART 2026 반기보고서 (접수 2026-08-14)", "공시 2026-09-30 주요사항보고서")."""


class FundamentalAgent:
    id = "fundamental_agent"
    output_contract = "FundamentalResult"

    def run(self, ctx: WorkerContext) -> dict:
        data = gather(ctx)
        prompt = user_prompt({
            "종목": {"symbol": ctx.symbol, "name": ctx.name, "market": ctx.market},
            "재무 (DART, 코드가 정리)": data["financials"] or _missing(data["financialsNote"]),
            "코드가 계산한 지표 (퍼센트 단위)": data["metrics"] or _missing(data["financialsNote"]),
            f"최근 {DISCLOSURE_DAYS}일 공시 목록 (최신순)": data["filings"] or _missing(data["filingsNote"]),
        })
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), prompt, contract=self.output_contract)
        return finish(reply.data, data)


def gather(ctx: WorkerContext) -> dict:
    """재무 요약·지표·공시 목록과 없을 때의 이유, 공시 제목을 거른 사유(guarded)."""
    data = {"financials": None, "metrics": None, "filings": [], "guarded": [], "evidence": [],
            "financialsNote": None, "filingsNote": None}
    dart, reason = _dart(ctx)
    if reason:
        data["financialsNote"] = data["filingsNote"] = reason
    else:
        today = timezone.now().astimezone(KST).date()
        got = fetch_all({
            "fundamentals": lambda: sources.fundamentals(ctx.symbol, today),
            "disclosures": lambda: dart.disclosures(ctx.symbol, today, days=DISCLOSURE_DAYS),
        }, min(DATA_TIMEOUT_SEC, time_left(ctx) - LLM_RESERVE_SEC))
        _use_fundamentals(data, got["fundamentals"], ctx.symbol)
        _use_disclosures(data, got["disclosures"], today)
    if data["financials"] is None:
        data["evidence"].insert(0, f"재무 자료 없음: {data['financialsNote']}")
    if not data["filings"] and data["filingsNote"]:
        data["evidence"].append(f"공시 목록 없음: {data['filingsNote']}")
    return data


def finish(answer: dict, data: dict) -> dict:
    """metrics를 코드 값으로, recentFilings를 받은 공시 목록에 있는 것만으로, evidence 앞에 코드가 만든 출처를."""
    result = dict(answer)
    result["metrics"] = data["metrics"]
    result["recentFilings"] = match_filings(result.get("recentFilings") or [], data["filings"])
    extra = [e for e in result.get("evidence") or [] if e not in data["evidence"]]
    result["evidence"] = [*data["evidence"], *extra][:MAX_EVIDENCE]
    if data["guarded"]:
        result["_guarded"] = data["guarded"]
    return result


def metrics_of(fundamentals: dict, price: float | None) -> dict:
    """FundamentalResult.metrics (퍼센트 단위). PER = 종가 ÷ EPS(TTM, 양수일 때), PBR = 종가 ÷ BPS.

    ROE·매출 성장률·영업이익률은 장기투자 펀더멘털 점검과 같은 계산(fundamentals_check.metrics — ROE는 TTM 순이익 ÷ 자본총계).
    """
    values = fundamentals_check.metrics(fundamentals)["values"]
    per_share = fundamentals.get("perShare") or {}
    eps, bps = _number(per_share.get("epsTtm")), _number(per_share.get("bps"))
    return {
        "per": round(price / eps, 2) if price and eps and eps > 0 else None,
        "pbr": round(price / bps, 2) if price and bps and bps > 0 else None,
        "roe": _pct(values.get("roe")),
        "revenueGrowthPct": _pct(values.get("revenueGrowth")),
        "opMarginPct": _pct(values.get("operatingMargin")),
    }


def match_filings(items: list[dict], filings: list[dict]) -> list[dict]:
    """LLM이 고른 공시 중 받은 목록에 있는 것만 (같은 제목, 또는 같은 날짜에 한쪽 제목이 다른 쪽을 품을 때). 날짜·제목은 목록 값."""
    out, used = [], set()
    for item in items:
        title = _squash(item.get("title"))
        for index, filing in enumerate(filings):
            known = _squash(filing["title"])
            same_day = item.get("date") == filing["date"]
            if index not in used and title and (title == known or (same_day and (title in known or known in title))):
                used.add(index)
                out.append({"date": filing["date"], "title": filing["title"], "impact": item["impact"]})
                break
    return out[:MAX_FILINGS]


def fetch_all(calls: dict, seconds: float) -> dict:
    """calls({이름: 인자 없는 함수})를 동시에 돌려 seconds 안의 결과 {이름: 값 또는 예외}. 끝나지 못한 것은 TimeoutError.

    끝나지 못한 조회는 데몬 스레드에서 마저 돌고 결과는 버린다 (sources의 하루 캐시가 다음 리포트에 쓴다). DB는 쓰지 않는다.
    """
    if seconds <= 0:
        return {name: TimeoutError(TOO_SLOW) for name in calls}
    out: dict = {}

    def run(name, fn):
        try:
            out[name] = fn()
        except Exception as e:  # 이유는 부르는 쪽이 자료 없음 문장으로 바꾼다
            out[name] = e

    threads = {name: threading.Thread(target=run, args=(name, fn), name=f"report-data-{name}", daemon=True)
               for name, fn in calls.items()}
    for thread in threads.values():
        thread.start()
    end = time.monotonic() + seconds
    for thread in threads.values():
        thread.join(max(end - time.monotonic(), 0))
    return {name: TimeoutError(TOO_SLOW) if thread.is_alive() else out.get(name)
            for name, thread in threads.items()}


def time_left(ctx: WorkerContext) -> float:
    """단계 제한 시간까지 남은 초 (ctx.deadline은 healing.clock 기준)."""
    return ctx.deadline - healing.clock()


def _dart(ctx: WorkerContext):
    """(DartClient, None) 또는 (None, 자료 없음 이유): 미국 종목·DART 키 없음·남은 시간 없음."""
    if ctx.market != "KR":
        return None, NOT_KR
    dart = sources.dart_client()
    if dart is None:
        return None, sources.NO_DART_KEY
    if time_left(ctx) - LLM_RESERVE_SEC <= 0:
        return None, TOO_SLOW
    return dart, None


def _use_fundamentals(data: dict, found, symbol: str) -> None:
    if isinstance(found, Exception):
        data["financialsNote"] = _reason(found)
        return
    if not found:
        data["financialsNote"] = sources.NO_FILINGS
        return
    price = _close_price(symbol)
    report = found.get("report") or {}
    label = fundamentals_check.report_label(found)
    data["metrics"] = metrics_of(found, price)
    data["financials"] = {
        "report": label, "receivedAt": report.get("receivedAt"), "basis": found.get("basis"),
        "currency": found.get("currency"), "annual": found.get("annual"), "interim": found.get("interim"),
        "ttm": found.get("ttm"), "balance": found.get("balance"), "closePrice": price,
    }
    received = f" (접수 {report['receivedAt']})" if report.get("receivedAt") else ""
    data["evidence"].append(f"DART {label or '재무제표'} 재무{received}")


def _use_disclosures(data: dict, found, today) -> None:
    if isinstance(found, Exception):
        data["filingsNote"] = _reason(found)
        return
    reasons = []
    for item in ((found or {}).get("items") or [])[:FILINGS_IN_PROMPT]:
        title, why = clean_text(item.get("title"), TITLE_MAX)
        filer, why_filer = clean_text(item.get("filer"), TITLE_MAX)
        reasons += [why, why_filer]
        if title.strip() and item.get("date"):
            data["filings"].append({"date": item["date"], "title": title.strip(), "filer": filer.strip() or None})
    data["guarded"] = merge_reasons(*reasons)
    start = today - timedelta(days=DISCLOSURE_DAYS)
    if data["filings"]:
        data["evidence"].append(f"DART 공시 목록 {start}~{today} {len(data['filings'])}건")
    else:
        data["filingsNote"] = f"최근 {DISCLOSURE_DAYS}일 공시가 없어요"


def _close_price(symbol: str) -> float | None:
    """PER·PBR에 쓰는 직전 정규장 종가 (장마감 기준). 받지 못하면 None (두 지표만 비운다)."""
    try:
        return market.close_price(symbol)
    except Unavailable:
        return None


def _reason(error: Exception) -> str:
    if isinstance(error, sources.DartUnavailable):
        return str(error) or sources.DART_FAILED
    if isinstance(error, TimeoutError):
        return TOO_SLOW
    return sources.DART_FAILED


def _missing(note: str | None) -> str:
    return f"{NO_DATA} ({note})" if note else NO_DATA


def _number(value) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _pct(ratio: float | None) -> float | None:
    return None if ratio is None else round(ratio * 100, 2)


def _squash(text) -> str:
    return "".join(str(text or "").split())
