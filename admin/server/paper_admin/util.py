"""시각·문장 다듬기 공용 함수."""
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
MAX_TEXT = 300
_URL = re.compile(r"(?P<base>[a-zA-Z][a-zA-Z0-9+.-]*://[^/\s?#'\"<>]+)(?P<rest>[/?#][^\s'\"<>]*)?")
_WEBHOOK_PATH = re.compile(r"/api/(?:v\d+/)?webhooks/[^\s'\"<>]+")  # requests 오류 문장의 "url: /api/webhooks/<id>/<토큰>"


def utcnow() -> datetime:
    return datetime.now(UTC)


def parse_time(value: Any) -> datetime | None:
    """datetime·ISO 문자열 → aware datetime. 시간대가 없으면 UTC로 본다 (Django USE_TZ 저장값)."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def iso(dt: datetime | None) -> str | None:
    """KST로 바꾼 ISO 8601 (`2026-10-08T09:30:00+09:00`)."""
    return dt.astimezone(KST).isoformat() if dt else None


def kst_day_start(now: datetime) -> datetime:
    return now.astimezone(KST).replace(hour=0, minute=0, second=0, microsecond=0)


def kst_date(dt: datetime) -> str:
    return dt.astimezone(KST).date().isoformat()


def ms_between(start: datetime | None, end: datetime | None) -> int | None:
    if not start or not end:
        return None
    return round((end - start).total_seconds() * 1000)


def age_sec(since: datetime | None, now: datetime) -> float | None:
    return (now - since).total_seconds() if since else None


def mask_urls(text: str) -> str:
    """URL의 경로·쿼리를 `…`로 가린다 (웹훅 주소 등)."""
    text = _URL.sub(lambda m: m.group("base") + ("/…" if m.group("rest") else ""), text)
    return _WEBHOOK_PATH.sub("/api/webhooks/…", text)


def clean_text(value: Any, limit: int = MAX_TEXT) -> str | None:
    """오류 문장: URL 경로·쿼리를 가리고 300자로 자른다."""
    if value is None:
        return None
    text = mask_urls(str(value))
    return text if len(text) <= limit else text[: limit - 1] + "…"


def clean_json(value: Any) -> Any:
    """JSON 값 안의 문자열을 모두 clean_text로 다듬는다."""
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, dict):
        return {str(k): clean_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clean_json(v) for v in value]
    return value


def num(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def usd(value: float) -> float:
    """합계의 소수 오차를 지운다."""
    return round(value, 6)


def days_ago(now: datetime, days: int) -> datetime:
    return now - timedelta(days=days)
