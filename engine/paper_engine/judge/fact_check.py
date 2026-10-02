"""사실 검증. AI가 근거로 인용한 값을 종목 데이터와 대조하고, 매매 방침(스윙만, 보유 기간, 진입가)에
맞지 않는 시나리오를 거른다."""
import re

from .scenario import SWING_MAX_DAYS, SWING_MIN_DAYS, TRADABLE_HORIZONS

EVIDENCE_TOLERANCE = 0.005  # 근거 숫자와 실제 값의 허용 오차 (상대)
MAX_ENTRY_GAP = 0.05  # 진입가와 현재가의 최대 괴리
MIN_QUOTE = 20  # 원문의 일부만 인용할 때 필요한 최소 길이
# AI가 경로 앞부분을 빼고 쓰는 경우가 있어 (예: "ratios.per") 이 항목들 아래에서도 찾는다.
PATH_PREFIXES = ("", "fundamentals.", "indicators.")


def resolve(snapshot: dict, path: str):
    """'indicators.rsi14', 'recentCandles[-1].close' 같은 경로로 값을 찾는다."""
    for prefix in PATH_PREFIXES:
        try:
            return _resolve(snapshot, prefix + path)
        except (KeyError, IndexError, ValueError, TypeError):
            continue
    raise KeyError(path)


def _resolve(snapshot: dict, path: str):
    value = snapshot
    for part in re.sub(r"\[(-?\d+)\]", r".\1", path).strip(".").split("."):
        if isinstance(value, list):
            value = value[int(part)]
        else:
            value = value[part]
    return value


def _same_text(claimed: str, actual: str) -> bool:
    """공백 차이는 무시한다. 원문의 일부를 그대로 옮긴 것도 인정한다."""
    a, b = " ".join(claimed.split()), " ".join(actual.split())
    return a == b or (len(a) >= MIN_QUOTE and a in b)


def _policy_errors(raw: dict) -> list[str]:
    """스윙만 매매한다. 보유 기간은 거래일 기준."""
    errors = []
    horizon = raw.get("horizon")
    if horizon not in TRADABLE_HORIZONS:
        errors.append(f"매매하지 않는 투자 기간: {horizon} (허용 {', '.join(TRADABLE_HORIZONS)})")
    allowed = f"허용 {SWING_MIN_DAYS}~{SWING_MAX_DAYS}거래일"
    try:
        days = float(raw["holdingDays"])
    except (KeyError, TypeError, ValueError):
        errors.append(f"holdingDays 누락 또는 형식 오류: {raw.get('holdingDays')!r} ({allowed})")
    else:
        if not SWING_MIN_DAYS <= days <= SWING_MAX_DAYS:
            errors.append(f"보유 기간 {days:g}거래일이 허용 범위를 벗어남 ({allowed})")
    return errors


def fact_check(snapshot: dict, raw: dict) -> list[str]:
    """문제가 없으면 빈 리스트."""
    errors = _policy_errors(raw)
    for item in raw.get("rationale") or []:
        for ev in (item.get("evidence") or []) if isinstance(item, dict) else []:
            field_, claimed = ev.get("field"), ev.get("value")
            try:
                actual = resolve(snapshot, field_)
            except (KeyError, IndexError, ValueError, TypeError, AttributeError):
                errors.append(f"데이터에 없는 항목 인용: {field_}")
                continue
            numbers = (int, float)
            if isinstance(actual, numbers) and isinstance(claimed, numbers):
                if abs(claimed - actual) > max(abs(actual) * EVIDENCE_TOLERANCE, 1e-9):
                    errors.append(f"{field_}: 인용값 {claimed} ≠ 실제값 {actual}")
            elif isinstance(actual, str) and isinstance(claimed, str):
                if not _same_text(claimed, actual):
                    errors.append(f"{field_}: 인용한 문장이 원문과 다름")
            elif claimed != actual:
                errors.append(f"{field_}: 인용값 {claimed!r} ≠ 실제값 {actual!r}")
    try:
        gap = abs(float(raw["entryPrice"]) / snapshot["lastPrice"] - 1)
        if gap > MAX_ENTRY_GAP:
            errors.append(f"진입가가 현재가에서 {gap:.1%} 벗어남 (허용 {MAX_ENTRY_GAP:.0%})")
    except (KeyError, TypeError, ValueError):
        errors.append("entryPrice 누락 또는 형식 오류")
    return errors
