"""읽기 전용 조회. 웹(4C)과 CLI(`python -m paper_engine info ...`)가 쓴다.

주문이나 상태 변경은 하지 않는다. 결과는 JSON이며, 화면에 보이기 좋게 큰 필드는 줄인다.
"""
import json

from .config import ROOT
from .records.redis_client import Redis
from .records.store import Store
from .report import NEWS_PROVIDER, news_items
from .scheduler import ReservationBook, load_scan_result
from .strategies import StrategyBook

RUNS_DIR = ROOT / "runs"
MAX_RUN_FILES = 60  # 종목 분석 기록을 찾을 때 최근 파일만 본다


def _norm(s: str) -> str:
    return "".join(str(s).split()).upper()


def _matches(query: str, symbol: str, name: str) -> bool:
    q = _norm(query)
    return q == _norm(symbol) or q in _norm(name) or _norm(name) in q


def strategies(redis: Redis) -> list[dict]:
    out = []
    for s in StrategyBook(redis).all():
        result = load_scan_result(redis, s.id)
        out.append({"id": s.id, "summary": s.summary(), "status": s.status, "market": s.market,
                    "action": s.action, "candidates": s.candidates, "analyzeTop": s.analyze_top, "reports": s.reports,
                    "limit": s.limit_text(), "lastRunAt": s.last_run_at, "lastSummary": s.last_summary,
                    "latestPicks": [f"{p['name']}({p['symbol']}) {p['score']:.0f}점"
                                    for p in (result or {}).get("picks", [])[:10]]})
    return out


def scan_results(redis: Redis, strategy_id: int | None = None, market: str | None = None) -> list[dict]:
    """전략별 최근 선별 결과 (규칙, 통과 종목과 지표, 탈락·제외 사유)."""
    out = []
    for s in StrategyBook(redis).all():
        if (strategy_id and s.id != strategy_id) or (market and s.market != market):
            continue
        result = load_scan_result(redis, s.id)
        if result:
            out.append(result)
    return out


def _analysis_view(entry: dict, run_file: str, log: dict) -> dict:
    snap = entry.get("snapshot", {})
    research = snap.get("webResearch") or {}
    view = {
        "runFile": run_file, "startedAt": log.get("startedAt"), "strategy": log.get("strategy"),
        "paperBuy": log.get("paperBuy"), "symbol": snap.get("symbol"), "name": snap.get("name"),
        "lastPrice": snap.get("lastPrice"), "indicators": snap.get("indicators"),
        "fundamentals": snap.get("fundamentals"),
        "news": [n["title"] for n in news_items(snap)],  # 예전 형식 (제목만)
        "newsItems": news_items(snap), "newsProvider": NEWS_PROVIDER,  # 매체·게시 시각과 출처 표기 (U12)
        "brokerReports": snap.get("brokerReports"),
        "webResearch": [
            {"researcher": r.get("id"), "findings": [
                {k: f.get(k) for k in ("claim", "direction", "date", "sourceTitle", "sourceVerified")}
                for f in r.get("findings", [])],
             "upcomingEvents": r.get("upcomingEvents", [])}
            for r in research.get("researchers", [])],
        "modelResponseError": entry.get("modelResponseError"),
        "errors": entry.get("errors"),
        "candidates": [],
    }
    for c in entry.get("candidates", []):
        view["candidates"].append({
            "id": c.get("id"), "proposer": c.get("proposer"), "selected": c.get("selected"),
            "passed": c.get("passed"), "score": c.get("score"),
            "consensusProbability": c.get("consensus_probability"),
            "scenario": c.get("final") or c.get("scenario"), "factErrors": c.get("fact_errors"),
            "risk": c.get("assessment"), "critiques": c.get("critiques"), "approval": c.get("approval"),
            "reach": c.get("reach"),  # 목표가 도달 가능성 점검 (표시용). 이전 기록에는 없다
        })
    return view


def analyses(query: str, limit: int = 2) -> list[dict]:
    """최근 AI 분석 기록 중 query(종목코드나 이름)에 해당하는 것. 최신순."""
    out = []
    files = sorted(RUNS_DIR.glob("*.json"), reverse=True)[:MAX_RUN_FILES] if RUNS_DIR.exists() else []
    for path in files:
        try:
            log = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        for entry in log.get("results", []):
            snap = entry.get("snapshot", {})
            if _matches(query, snap.get("symbol", ""), snap.get("name", "")):
                out.append(_analysis_view(entry, f"runs/{path.name}", log))
                if len(out) >= limit:
                    return out
    return out


def stock(query: str, redis: Redis | None, store: Store) -> dict:
    """한 종목에 대해 알고 있는 것: 선별 결과(선정·탈락 이유), AI 분석, 모의 주문, 예약."""
    appearances, known = [], set()
    for result in (scan_results(redis) if redis else []):
        head = {"strategy": result.get("strategy"), "at": result.get("at"), "market": result.get("market")}
        for p in result.get("picks", []):
            known.add(f"{p['name']}({p['symbol']})")
            if _matches(query, p["symbol"], p["name"]):
                rank = result["picks"].index(p) + 1
                appearances.append(head | {"status": "규칙 통과", "scoreRank": rank, "pick": p,
                                           "analyzed": p["symbol"] in result.get("analyzed", [])})
        for key, label in (("dropped", "규칙 탈락"), ("excluded", "선별 대상 제외")):
            for d in result.get(key, []):
                known.add(f"{d['name']}({d['symbol']})")
                if _matches(query, d["symbol"], d["name"]):
                    appearances.append(head | {"status": label, "reason": d["reason"]})
    orders = [dict(r) for r in store.paper_orders() if _matches(query, r["symbol"], r["name"])]
    reservations = []
    if redis:
        reservations = [r.__dict__ for r in ReservationBook(redis).all()
                        if _matches(query, r.symbol, r.name)]
    found = {"query": query, "screening": appearances, "analyses": analyses(query),
             "paperOrders": orders, "reservations": reservations}
    if not (appearances or found["analyses"] or orders or reservations):
        # 이름이 조금 다를 수 있다 (예: 자회사 이름으로 물은 경우). 알고 있는 종목을 알려 준다.
        found["note"] = "일치하는 기록 없음. 최근 선별에 나온 종목 목록을 참고하세요."
        found["knownStocks"] = sorted(known)[:150]
    return found


def orders(redis: Redis | None, store: Store) -> dict:
    return {"paperOrders": [dict(r) for r in store.paper_orders()][-30:],
            "reservations": [r.__dict__ for r in ReservationBook(redis).all()] if redis else []}


def dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, indent=1, default=str)

