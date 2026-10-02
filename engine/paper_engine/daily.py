"""일일 리포트 자료. 모의 계좌, 모의 주문, 시장 기록, 전략·분석 기록, AI 분석 결과를 한 dict로 모은다.

여기서는 AI를 부르지 않는다. 기록 저장소와 Redis, 조회 API 값, 이미 끝난 AI 분석의 실행 기록(runs/*-daily.json)만 담는다.
분석 대상은 analysis_symbols가 고르고, 분석은 __main__.run_daily_analysis가 돌린다.
report.build_daily_html이 이 dict로 PDF를 만들고, serve가 매일 REPORT_HOUR(__main__)에 보낸다
(CLI daily-report로 바로 만들 수도 있다). 결과는 JSON으로 직렬화할 수 있어야 한다 (sqlite3.Row는 dict로 바꾼다).
"""
import json
from datetime import datetime, timedelta
from pathlib import Path

from . import info, report
from .agents import executor as ex
from .config import DEFAULT_COMMISSION, ROOT
from .data.kiwoom import KiwoomApiError
from .judge import screen
from .records import account as paper_account
from .records.market_log import AMOUNT, GAINERS, LOSERS
from .records.redis_client import RedisError
from .scheduler import ReservationBook

TOP = 10
MAX_RUN_FILES = 200  # 기간 안의 분석 기록을 찾을 때 최근 파일만 본다
DAILY_ANALYZE_MAX = 20  # 일일 분석 종목 수 상한 (종목당 AI 비용 약 $0.3)
MARKET_TOP_ANALYZE = 3  # 시장별 거래대금 상위 몇 개를 분석할지
RECENT_ANALYSIS_HOURS = 24  # 이 시간 안에 전략·수동 분석이 이미 분석한 종목은 일일 분석에서 뺀다
# 보유 종목 정보에는 종목 유형이 없어 이름으로 ETF·ETN을 거른다. 이름에 이 말이 없는 ETF(예: 미국 QQQ)는
# 걸러지지 않고 분석된다 (비용만 더 든다). 시장 기록의 거래대금 상위는 종목 유형으로 이미 걸렀다.
ETF_NAME_HINTS = ("ETF", "ETN", "TIGER", "KODEX", "KBSTAR", "HANARO", "ARIRANG", "KOSEF")


def _f(value) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _prices(client, symbols: list[str]) -> dict[str, float]:
    """현재가 (평가·표시용). 조회하지 못하면 빈 dict (체결가로 평가한다)."""
    if not (client and symbols):
        return {}
    try:
        return {p["symbol"]: float(p["lastPrice"]) for p in client.prices(symbols)}
    except (KiwoomApiError, OSError, KeyError, TypeError, ValueError):
        return {}


def _fx(client, store) -> float | None:
    """진행 중인 달러 종목이 있을 때만 환율을 조회한다. 실패하면 None (체결 환율로 평가)."""
    if not client or not any(r["currency"] == "USD" for r in store.paper_orders(ex.ACTIVE)):
        return None
    try:
        return float(client.exchange_rate()["rate"])
    except (KiwoomApiError, OSError, KeyError, TypeError, ValueError):
        return None


def _account(store, prices: dict[str, float], fx: float | None, rates: dict, now: datetime) -> dict:
    """모의 계좌 요약 + 전일 대비 (equity_daily의 오늘 전 마지막 기록)."""
    out = paper_account.summary(store, prices, fx, rates)
    prev = store.equity_days(1, before=f"{now.date()}")
    out["previous"] = dict(prev[-1]) if prev else None
    out["dailyChangeKrw"] = out["equityKrw"] - prev[-1]["equity_krw"] if prev else None
    return out


def _active(row, last: float | None) -> dict:
    gain, loss = ex.expected_pnl(row)
    filled = row["status"] == ex.EXIT_WATCHING
    unrealized = (last - row["fill_price"]) * row["filled_quantity"] if filled and last is not None else None
    return {"id": row["id"], "symbol": row["symbol"], "name": row["name"], "currency": row["currency"],
            "status": row["status"], "orderType": row["order_type"], "limitPrice": row["limit_price"],
            "requestedBy": row["requested_by"], "createdAt": row["created_at"],
            "quantity": row["filled_quantity"] if filled else row["quantity"], "filled": filled,
            "entryPrice": row["entry_price"], "fillPrice": row["fill_price"], "lastPrice": last,
            "target": row["target_price"], "stop": row["stop_price"], "expireDate": row["expire_date"],
            "expectedGain": gain, "expectedLoss": loss, "unrealized": unrealized, "note": row["note"]}


def _finished(row) -> dict:
    return {"id": row["id"], "symbol": row["symbol"], "name": row["name"], "currency": row["currency"],
            "status": row["status"], "quantity": row["filled_quantity"] or row["quantity"],
            "requestedBy": row["requested_by"], "fillPrice": row["fill_price"], "exitPrice": row["exit_price"],
            "exitReason": row["exit_reason"], "pnl": row["pnl"], "pnlKrw": row["pnl_krw"],
            "createdAt": row["created_at"], "closedAt": row["closed_at"], "note": row["note"]}


def _pnl_by_currency(rows) -> dict:
    out = {}
    for r in rows:
        if r["pnl"] is None:
            continue
        c = out.setdefault(r["currency"], {"pnl": 0.0, "pnlKrw": 0.0, "count": 0, "wins": 0})
        c["pnl"] += r["pnl"]
        c["pnlKrw"] += r["pnl_krw"] or 0.0
        c["count"] += 1
        c["wins"] += r["pnl"] > 0
    for c in out.values():
        c["winRate"] = c["wins"] / c["count"] if c["count"] else None
    return out


def _trades(store, prices: dict[str, float], since: str) -> dict:
    active_rows = store.paper_orders(ex.ACTIVE)
    touched = store.paper_orders_touched_since(since)
    finished = [r for r in touched if r["status"] in (ex.CLOSED, ex.CANCELED)]
    opened = [r for r in touched if r["created_at"] >= since]
    closed = [r for r in finished if r["status"] == ex.CLOSED]
    return {"active": [_active(r, prices.get(r["symbol"])) for r in active_rows],
            "finished": [_finished(r) for r in finished],
            "openedCount": len(opened),
            "realized": {c: v["pnl"] for c, v in _pnl_by_currency(closed).items()},
            "realizedKrw": sum(r["pnl_krw"] or 0.0 for r in closed) if closed else None,
            "cumulative": _pnl_by_currency(store.closed_paper_orders())}


def _ranking(row) -> dict:
    return {"rank": row["rank"], "symbol": row["symbol"], "name": row["name"],
            "securityType": row["security_type"], "lastPrice": row["last_price"],
            "changeRate": row["change_rate"], "tradingAmount": row["trading_amount"]}


def _markets(store, markets: tuple[str, ...]) -> dict:
    out = {}
    for m in markets:
        days = [{"day": d["day"], "benchSymbol": d["bench_symbol"], "benchClose": d["bench_close"],
                 "benchChange": d["bench_change"], "usdKrw": d["usd_krw"], "rankedAt": d["ranked_at"]}
                for d in store.market_days(m, TOP)]
        latest = days[-1]["day"] if days else None
        # ETF·ETN 등은 뺀다 (선별과 같은 기준). 기록에는 그대로 남아 있다
        lists = {key: [_ranking(r) for r in store.rankings(m, latest, type_)
                       if r["security_type"] in screen.TRADABLE_TYPES][:TOP] if latest else []
                 for key, type_ in (("amount", AMOUNT), ("gainers", GAINERS), ("losers", LOSERS))}
        out[m] = {"days": days, "latestDay": latest, **lists, "recordedDays": store.market_day_count(m),
                  "note": None if days else "시장 기록 없음 (serve가 정규장 마감 후 기록한다)"}
    return out


def _logs(runs_dir: Path, since: datetime, until: datetime):
    """기간 안의 실행 기록 (경로, 기록). 최근 파일부터, 읽지 못하는 파일은 건너뛴다."""
    files = sorted(runs_dir.glob("*.json"), reverse=True)[:MAX_RUN_FILES] if runs_dir.exists() else []
    for path in files:
        try:
            log = json.loads(path.read_text())
            started = datetime.fromisoformat(log["startedAt"])
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if since <= started <= until:
            yield path, log


def _runs(runs_dir: Path, since: datetime, until: datetime) -> list[dict]:
    out = []
    for path, log in _logs(runs_dir, since, until):
        n = report.summary(log)
        picks = [f"{r['snapshot'].get('name')}({r['snapshot'].get('symbol')})" for r in log.get("results") or []
                 if any(c.get("selected") for c in r.get("candidates") or [])]
        strategy = log.get("strategy")
        label = f"#{strategy['id']} {strategy['name']}" if strategy else "일일 분석" if log.get("tag") == "daily" else None
        out.append({"file": path.name, "startedAt": log["startedAt"], "strategy": label,
                    "symbols": n["symbols"], "picks": picks, "failed": n["failed"],
                    "costUsd": log.get("costUsd"), "paperBuy": log.get("paperBuy")})
    return sorted(out, key=lambda r: r["startedAt"])


def _records(store, redis, since: datetime, until: datetime, runs_dir: Path, halt_file: Path,
             backup_dir: Path) -> dict:
    out = {"strategies": None, "reservations": None}
    if redis:
        try:
            out["strategies"] = [{k: s[k] for k in ("id", "summary", "status", "lastRunAt", "lastSummary")}
                                 | {"latestPicks": s["latestPicks"][:5]} for s in info.strategies(redis)]
            out["reservations"] = [r.label for r in ReservationBook(redis).all()]
        except (RedisError, OSError) as e:
            out["redisError"] = str(e)
    out["runs"] = _runs(runs_dir, since, until)
    out["paper"] = store.summary()
    out["predictions"] = {"summary": store.prediction_summary(), "models": store.model_stats()}
    out["halted"] = halt_file.exists()
    backups = sorted(backup_dir.glob("trading-*.db")) if backup_dir.exists() else []
    out["latestBackup"] = backups[-1].name if backups else None
    return out


def _looks_like_etf(name) -> bool:
    upper = str(name or "").upper()
    return any(h in upper for h in ETF_NAME_HINTS)


def recent_analyses(runs_dir: Path, now: datetime, hours: float = RECENT_ANALYSIS_HOURS,
                    include_daily: bool = False) -> dict[str, dict]:
    """최근 hours시간 안에 전략·수동 분석이 이미 분석한 종목 → {"runFile", "startedAt", "result"} (가장 최근 것).

    일일 분석 기록은 기본으로 넣지 않는다 (어제 일일 분석 때문에 오늘 보유 종목을 건너뛰지 않게, 그리고
    리포트 분석 요청(daily-report --analyze)이 새로 분석하게). 전략·scan의 분석 대상 선정은 include_daily로 일일 분석 기록도 넣는다.
    모델 응답 에러로 중단된 종목도 분석되지 않은 것으로 본다.
    """
    out = {}
    for path, log in _logs(runs_dir, now - timedelta(hours=hours), now):
        if log.get("tag") == "daily" and not include_daily:
            continue
        for r in log.get("results") or []:
            symbol = (r.get("snapshot") or {}).get("symbol")
            if symbol and not r.get("modelResponseError") and symbol not in out:
                out[symbol] = {"runFile": f"runs/{path.name}", "startedAt": log["startedAt"],
                               "result": _analyzed(r, {})}
    return out


def active_strategy_markets(redis, notes: list | None = None) -> dict[str, list[int]]:
    """AI 분석을 하는 활성 전략의 시장 → 전략 번호들. Redis가 없거나 조회에 실패하면 빈 dict (그 시장도 분석한다)."""
    out: dict[str, list[int]] = {}
    if not redis:
        return out
    try:
        items = info.strategies(redis)
    except (RedisError, OSError) as e:
        if notes is not None:
            notes.append(f"전략을 조회하지 못해 거래대금 상위를 포함함: {e}")
        return out
    for s in items:
        if s["status"] == "active" and s.get("analyzeTop"):
            out.setdefault(s["market"], []).append(s["id"])
    return out


def analysis_symbols(data: dict, recent: dict[str, dict] | None = None,
                     active_markets: dict[str, list[int]] | None = None, limit: int = DAILY_ANALYZE_MAX,
                     notes: list | None = None) -> list[dict]:
    """일일 AI 분석 대상 [{"symbol", "name", "role", "earlier"}]. collect(분석 없이)의 결과에서 고른다.

    순서: 모의 계좌 보유 종목 → 진행 중 모의 주문 종목 → 시장별 최신 기록의 거래대금 상위 MARKET_TOP_ANALYZE개.
    같은 종목은 한 번만 넣고 역할을 이어 붙인다 (예: "보유·자동 관리"). 건너뛴 것은 notes에 남긴다.
    - recent(recent_analyses)에 있는 종목은 다시 분석하지 않는다. earlier에 그 기록과 결과를 담아 돌려준다 (표에 재사용).
    - active_markets(active_strategy_markets)에 있는 시장은 그 전략이 매일 정규장 전에 거래대금 상위를 분석하므로
      거래대금 상위 그룹을 통째로 뺀다. 보유·자동 관리 종목은 이 규칙으로 빠지지 않는다.
    새로 분석할 것(earlier가 None)만 limit개까지 남긴다.
    """
    notes = [] if notes is None else notes
    recent, active_markets = recent or {}, active_markets or {}
    out: dict[str, dict] = {}
    skipped = []

    def add(symbol, name, role, check_etf=True):
        if not symbol:
            return
        if symbol in out:
            if role not in out[symbol]["role"].split("·"):
                out[symbol]["role"] += f"·{role}"
            return
        if check_etf and _looks_like_etf(name):
            skipped.append(f"{name}({symbol})")
            return
        out[symbol] = {"symbol": symbol, "name": name, "role": role, "earlier": recent.get(symbol)}

    account = data.get("account") or {}
    for i in account.get("holdings") or []:
        add(i.get("symbol"), i.get("name"), "보유")
    for r in (data.get("trades") or {}).get("active") or []:
        add(r.get("symbol"), r.get("name"), "모의 주문")
    for m, d in (data.get("markets") or {}).items():
        label = report.MARKET_LABEL.get(m, m)
        if active_markets.get(m):
            ids = ", ".join(f"#{i}" for i in active_markets[m])
            notes.append(f"{label} 거래대금 상위는 전략 {ids}이(가) 매일 분석하므로 제외")
            continue
        if not d.get("latestDay"):
            notes.append(f"{label} 시장 기록이 없어 거래대금 상위는 분석하지 않음")
            continue
        for r in (d.get("amount") or [])[:MARKET_TOP_ANALYZE]:
            add(r.get("symbol"), r.get("name"), f"거래대금 상위 ({label})", check_etf=False)
    if skipped:
        notes.append("ETF·ETN으로 보여 분석에서 뺌: " + ", ".join(dict.fromkeys(skipped)))
    items = list(out.values())
    earlier = [x for x in items if x["earlier"]]
    if earlier:
        notes.append(f"최근 {RECENT_ANALYSIS_HOURS}시간 안에 분석된 {len(earlier)}종목은 다시 분석하지 않고 그 결과를 씀")
    fresh = [x for x in items if not x["earlier"]]
    if len(fresh) > limit:
        notes.append(f"분석 대상 {len(fresh)}종목 중 앞 {limit}종목만 분석 (뺀 종목: "
                     + ", ".join(f"{x['name']}({x['symbol']})" for x in fresh[limit:]) + ")")
        dropped = {x["symbol"] for x in fresh[limit:]}
        items = [x for x in items if x["symbol"] not in dropped]
    return items


def latest_daily_run(runs_dir: Path, day: str) -> Path | None:
    """그 날(YYYYMMDD 또는 YYYY-MM-DD)의 일일 분석 기록(runs/{day}-*-daily.json) 중 가장 최근 것."""
    day = day.replace("-", "")
    files = sorted(runs_dir.glob(f"{day}-*-daily.json")) if runs_dir.exists() else []
    return files[-1] if files else None


def _pick(c: dict) -> dict:
    s = c.get("final") or c.get("scenario") or {}
    prob = c.get("consensus_probability")
    return {"entry": _f(s.get("entry_price")), "target": _f(s.get("target_price")), "stop": _f(s.get("stop_price")),
            "probability": prob if prob is not None else _f(s.get("probability")),
            "holdingDays": s.get("holding_days"), "reason": (c.get("approval") or {}).get("reason")}


def _analyzed(entry: dict, roles: dict) -> dict:
    snap = entry.get("snapshot") or {}
    cs = entry.get("candidates") or []
    picks = [c for c in cs if c.get("selected")]
    reasons = []
    if entry.get("modelResponseError"):
        outcome, reasons = "분석 중단", [f"모델 응답 에러: {entry['modelResponseError']}"]
    elif picks:
        outcome = "매수 추천"
    elif cs:
        outcome = "추천 없음"
        # 점수가 높은 시나리오의 탈락 사유부터 (예전 기록에는 판정 사유가 따로 없다)
        for c in sorted(cs, key=lambda c: c.get("score") or 0, reverse=True):
            reasons += c.get("rejectReasons", c.get("fact_errors")) or []
        reasons = list(dict.fromkeys(reasons))[:2]
    else:
        outcome = "제안 없음"
    scores = [c["score"] for c in cs if c.get("score") is not None]
    symbol = snap.get("symbol")
    return {"symbol": symbol, "name": snap.get("name"), "currency": snap.get("currency", "KRW"),
            "role": roles.get(symbol), "outcome": outcome, "bestScore": max(scores) if scores else None,
            "scenarios": len(cs), "pick": _pick(picks[0]) if picks else None, "reasons": reasons}


def _earlier(items: list) -> list[dict]:
    """최근 분석을 재사용한 종목을 표 항목으로 (결과는 그 기록의 것, 역할은 이번 선정의 것)."""
    return [x["earlier"]["result"] | {"role": x.get("role"),
                                      "earlier": {k: x["earlier"][k] for k in ("runFile", "startedAt")}}
            for x in items if x.get("earlier")]


def _analysis(run: Path | None, roles: dict | None, reused: bool, notes: list | None,
              earlier: list | None) -> dict | None:
    notes = list(notes or [])
    empty = {"runFile": None, "startedAt": None, "reused": False, "costUsd": None,
             "symbols": _earlier(earlier or []), "notes": notes}
    if run is None:
        return empty if notes or empty["symbols"] else None
    try:
        log = json.loads(run.read_text())
    except (OSError, ValueError) as e:
        return empty | {"runFile": run.name, "notes": notes + [f"분석 기록을 읽지 못함: {e}"]}
    roles = roles or log.get("roles") or {}
    earlier = earlier if earlier is not None else log.get("earlier") or []
    return {"runFile": run.name, "startedAt": log.get("startedAt"), "reused": reused, "costUsd": log.get("costUsd"),
            "symbols": [_analyzed(r, roles) | {"earlier": None} for r in log.get("results") or []]
            + _earlier(earlier), "notes": notes}


def collect(store, redis, client, now: datetime, days: int = 1, *, markets: tuple[str, ...] = ("KR",),
            commission: dict | None = None, runs_dir: Path | None = None,
            halt_file: Path | None = None, backup_dir: Path | None = None, analysis_run: Path | None = None,
            roles: dict[str, str] | None = None, reused: bool = False,
            analysis_notes: list[str] | None = None, earlier: list[dict] | None = None) -> dict:
    """리포트 자료. client가 None이면 현재가·환율을 조회하지 않는다 (보유는 체결가로 평가).

    markets는 시장 동향에 넣을 시장 (MARKETS). commission은 시장별 모의 수수료율 (대기 매수 금액 계산).
    analysis_run은 일일 AI 분석의 실행 기록. roles(종목 → 역할)와 earlier(analysis_symbols 중 최근 분석을 재사용한
    항목)가 없으면 기록에 넣어 둔 값을 쓴다. analysis는 분석도 메모도 없으면 None, 새로 분석하지 않았으면 runFile이 None이다.
    """
    since_dt = now - timedelta(days=days)
    since = since_dt.isoformat()
    prices = _prices(client, sorted({r["symbol"] for r in store.paper_orders(ex.ACTIVE)}))
    try:
        account = _account(store, prices, _fx(client, store), commission or dict(DEFAULT_COMMISSION), now)
    except paper_account.FxUnavailable as e:
        account = {"error": str(e)}
    return {"period": {"since": since, "until": now.isoformat(), "days": days},
            "account": account,
            "trades": _trades(store, prices, since),
            "markets": _markets(store, markets),
            "records": _records(store, redis, since_dt, now, runs_dir or ROOT / "runs",
                                halt_file or ROOT / "data" / "HALT", backup_dir or ROOT / "data" / "backups"),
            "analysis": _analysis(analysis_run, roles, reused, analysis_notes, earlier)}


def caption(data: dict) -> str:
    """리포트 첨부와 함께 보내는 2~4줄 요약."""
    p, t, a = data["period"], data["trades"], data.get("account") or {}
    lines = [f"[일일 리포트] {p['since'][:16].replace('T', ' ')} ~ {p['until'][:16].replace('T', ' ')}"]
    realized = " / ".join(ex.signed_money(v, c) for c, v in sorted(t["realized"].items())) or "없음"
    lines.append(f"진행 중 모의 주문 {len(t['active'])}건 · 기간 확정 손익 {realized}")
    if a.get("error"):
        lines.append(f"계좌 평가 실패: {a['error']}"[:200])
    elif a:
        change = (f" · 전일 대비 {ex.signed_money(a['dailyChangeKrw'], 'KRW')}"
                  if a.get("dailyChangeKrw") is not None else "")
        lines.append(f"모의 계좌 {a['equityKrw']:,.0f}원 (현금 {a['cashKrw']:,.0f}원 + 보유 {a['holdingsValueKrw']:,.0f}원) "
                     f"· 초기 자금 대비 {ex.signed_money(a['profitKrw'], 'KRW')} ({a['profitRate']:+.2%}){change}")
    pr = ((data.get("records") or {}).get("predictions") or {}).get("summary")
    if pr:
        lines.append(f"기록: 시나리오 {pr['total']}건 (청산 {pr['closed']}건)")
    n = data.get("analysis") or {}
    if n.get("symbols"):
        picks = sum(1 for x in n["symbols"] if x["outcome"] == "매수 추천")
        earlier = sum(1 for x in n["symbols"] if x.get("earlier"))
        lines.append(f"AI 분석 {len(n['symbols'])}종목" + (f" (최근 분석 재사용 {earlier}종목 포함)" if earlier else "")
                     + f" · 추천 {picks}개 · 비용 ${n.get('costUsd') or 0:.2f}"
                     + (" (오늘 앞서 한 분석 재사용)" if n.get("reused") else ""))
    return "\n".join(lines)
