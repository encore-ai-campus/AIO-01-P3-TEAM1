"""매일 자동 추천 — 시연용 (docs/tasks/06-추천·자동매매.md T6-6): 국내 거래일 AUTO_RECOMMEND_AT(KST) 이후 하루 한 번
선별(reports.autoreport.auto.select) 상위 종목마다 시연 규칙 추천(AI 아님, demo.recommend)을 만들어 팀 전체에 알린다.

AUTO_RECOMMEND=demo일 때만 돈다 (기본 off — 선별이 증권사 조회를 100번 넘게 한다). 엔진 루프의 "자동 추천" 단계가 tick을 부른다.
하루 한 번: 시작할 때 시도 표시(RUNS_DIR/autotrade/recommend-<날짜>-<시장>.json)를 먼저 남기고, 표시가 있으면 그날은 다시 하지 않는다.
선별이 실패해도 표시는 남는다 (그날 몇 번이고 다시 조회하지 않게). 결과·오류도 표시 파일에 적는다.
그날 선별 파일이 이미 있으면(자동 리포트가 먼저 선별했으면) 다시 선별하지 않고 그것을 쓴다. 만든 추천 id는 선별 파일의 recommendationIds에 넣는다.
"""
import json
from datetime import date, datetime
from zoneinfo import ZoneInfo

from reports.autoreport import auto as screening  # reports 앱 소유 (선별)
from trading import market

from config import engine

from .. import conf
from . import demo

KST = ZoneInfo("Asia/Seoul")
MARKET = "KR"


def _marker(market_: str, day: date):
    return engine.RUNS_DIR / "autotrade" / f"recommend-{day:%Y-%m-%d}-{market_}.json"


def _mark(market_: str, day: date, **fields) -> None:
    path = _marker(market_, day)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"market": market_, "day": f"{day}", **fields}, ensure_ascii=False), encoding="utf-8")


def done(market_: str, day: date) -> bool:
    """그날 이미 시도했나 (시도 표시가 있거나 선별 파일의 recommendationIds가 채워져 있으면)."""
    if _marker(market_, day).exists():
        return True
    result = screening.load(market_, day)
    return bool(result and result.get("recommendationIds"))


def trading_day(market_: str, now: datetime) -> bool:
    """오늘(KST)에 정규장이 있나 (장 달력 기준. 휴장일이면 False)."""
    day = now.astimezone(KST).date()
    return any(start.astimezone(KST).date() == day for start, _ in market.sessions(market_))


def tick(now: datetime, log) -> int:
    """엔진 루프의 "자동 추천" 단계. 조건이 맞으면 run. 만든 추천 수를 돌려준다."""
    if conf.auto_recommend() != "demo":
        return 0
    local = now.astimezone(KST)
    if local.time() < conf.auto_recommend_at() or done(MARKET, local.date()):
        return 0
    if not trading_day(MARKET, now):
        return 0
    return run(MARKET, conf.auto_recommend_top(), now, log)


def run(market_: str, top: int, now: datetime, log) -> int:
    """지금 선별(그날 파일이 있으면 그것)하고 상위 top 종목마다 시연 추천을 만든다. 한 종목의 실패는 로그만 남긴다."""
    day = now.astimezone(KST).date()
    _mark(market_, day, status="running", startedAt=now.isoformat())
    try:
        result = screening.load(market_, day) or screening.select(market_, top, now)
    except Exception as e:  # 선별 실패: 표시를 남겨 그날은 다시 하지 않는다
        error = f"{type(e).__name__}: {getattr(e, 'detail', e)}"
        _mark(market_, day, status="failed", startedAt=now.isoformat(), error=error)
        log(f"[자동 추천] {day} {market_} 선별 실패 (오늘은 다시 하지 않음): {error}")
        return 0
    ids = []
    for pick in (result.get("picks") or [])[:top]:
        symbol, name = pick.get("symbol"), pick.get("name") or ""
        try:
            rec = demo.recommend(None, symbol, now)
        except Exception as e:  # 한 종목의 문제가 나머지를 막지 않게
            log(f"[자동 추천] {name}({symbol}) 시연 추천을 만들지 못함: {getattr(e, 'detail', e)}")
            continue
        ids.append(rec.id)
        log(f"[자동 추천] {rec.name}({rec.symbol}) → 시연 추천 #{rec.id}")
    with screening.locked():  # 자동 리포트(reports.autoreport.auto)도 같은 파일을 고친다 — 최신 파일에 더한다
        latest = screening.load(market_, day) or result
        latest["recommendationIds"] = [*(latest.get("recommendationIds") or []), *ids]
        screening.save(latest)
    _mark(market_, day, status="done", startedAt=now.isoformat(), recommendationIds=ids)
    log(f"[자동 추천] {day} {market_} 선별 {len(latest.get('picks') or [])}종목 → 시연 추천 {len(ids)}개")
    return len(ids)
