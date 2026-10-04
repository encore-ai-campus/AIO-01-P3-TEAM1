"""자동 리포트의 선별 (docs/tasks/01-인프라.md T1-3): 엔진 screen_market 결과를 그날 파일로 남긴다.

    PAPER_ROOT/runs/screening/<YYYY-MM-DD>-<market>.json   (KST 날짜, docs/API.md ScreeningResult 형식)

screen_market은 증권사 조회를 100번 넘게 한다 (거래대금 순위·종목 정보·후보마다 일봉). 하루 한 번만, 장 시작 전에 부른다.
reportIds는 자동 리포트 신청(T1-4)이, recommendationIds는 매일 자동 추천(autotrade.auto)이 채운다.
"""
import json
from datetime import date, datetime
from zoneinfo import ZoneInfo

from django.utils import timezone
from paper_engine.__main__ import screen_market

from config import engine
from config.api import Unavailable

KST = ZoneInfo("Asia/Seoul")
SCREEN_CANDIDATES = 30  # 규칙 점수를 매길 거래대금 상위 후보 수 (엔진 전략의 기본값과 같다)


def _dir():
    return engine.RUNS_DIR / "screening"


def _path(market: str, day: date):
    return _dir() / f"{day:%Y-%m-%d}-{market}.json"


def select(market: str = "KR", top: int = 3, now: datetime | None = None) -> dict:
    """거래대금 상위 후보를 규칙으로 점수 매겨 점수 순 상위 top개를 고르고 그날 파일에 저장한다. 증권사 키가 없으면 Unavailable."""
    if engine.broker_client() is None:
        raise Unavailable("증권사 조회 키가 없어 선별할 수 없습니다.")
    now = now or timezone.now()
    found = screen_market(engine.engine_config(), market, candidates=max(SCREEN_CANDIDATES, top))
    picks = sorted(found.get("picks") or [], key=lambda p: p.get("score", 0), reverse=True)[:max(top, 0)]
    result = found | {"market": market, "at": now.astimezone(KST).isoformat(), "picks": picks,
                      "reportIds": [], "recommendationIds": []}
    result.setdefault("dropped", [])
    result.setdefault("excluded", [])
    save(result)
    return result


def save(result: dict) -> None:
    """선별 결과를 그 날짜(at의 KST 날짜)·시장 파일에 쓴다 (임시 파일에 쓴 뒤 바꿔 끼운다)."""
    day = datetime.fromisoformat(result["at"]).astimezone(KST).date()
    path = _path(result["market"], day)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    temp.replace(path)


def load(market: str, day: date) -> dict | None:
    """그날 선별 결과. 없거나 읽지 못하면 None."""
    try:
        data = json.loads(_path(market, day).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
