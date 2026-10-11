"""매매 종목 선정 팀의 입력과 선정 Guard (docs/design/AI_AGENT_WORKFLOW.md 2·4장, 담당 1·3).

- `team_inputs(report)`: 선정 팀 실행(Report team=stock_selection)이 볼 오늘의 후보 표. Orchestrator가 실행 시작 때 한 번 부른다.
  후보 표는 그날 선별 파일(reports/autoreport/auto.py)의 `candidates`(규칙을 통과한 후보, 점수 순)다.
- `guard(...)`: AI 선정안(또는 Fallback이면 규칙 점수 순)을 결정론적 규칙으로 걸러 최종 top개를 정한다. AI는 제안만 한다 —
  후보 밖 종목·투자유의·고위험 공시·같은 테마 3개째를 빼고, 모자라면 규칙 점수 순으로 채운다. 점수·RSI 같은 숫자는 늘 후보 표(코드) 값이다.
  투자유의 조회가 실패한 종목은 통과시키지 않는다 (fail closed).
"""
from collections import Counter
from collections.abc import Callable
from zoneinfo import ZoneInfo

from ..agents.base import WorkerError

KST = ZoneInfo("Asia/Seoul")
THEME_LIMIT = 2                       # 같은 테마는 최종 종목에 2개까지
NEWS, FILING = "news_screen_agent", "filing_screen_agent"   # Guard가 읽는 조사 Worker
# filtered[].stage — 어느 검사에서 빠졌나
CANDIDATES, WARNINGS, FILINGS, THEME = "candidates", "warnings", "filing", "theme"


def candidates_of(screening: dict | None) -> list[dict]:
    """선별 파일의 후보 표 (점수 순). 예전 파일처럼 candidates가 없으면 picks를 후보로 본다. symbol이 없는 항목은 뺀다."""
    screening = screening if isinstance(screening, dict) else {}
    found = screening.get("candidates")
    if not isinstance(found, list):
        found = screening.get("picks")
    return [c for c in found or [] if isinstance(c, dict) and isinstance(c.get("symbol"), str) and c["symbol"]]


def team_inputs(report) -> dict:
    """선정 팀의 공용 입력 {"market", "day", "candidates"} (WorkerContext.team_inputs).

    리포트가 만들어진 날(KST)·시장의 선별 파일을 읽고, 그 파일이 이 실행을 가리키는지(selection.reportId) 확인한다.
    파일이 없거나 다른 실행을 가리키거나 후보가 없으면 WorkerError.
    """
    from . import auto  # auto가 이 모듈을 읽으므로 맨 위에서 읽지 않는다 (순환 방지)

    day = report.created_at.astimezone(KST).date()
    screening = auto.load(report.market, day)
    selection = (screening or {}).get("selection")
    if not isinstance(selection, dict) or selection.get("reportId") != report.id:
        raise WorkerError("오늘의 후보 표가 없습니다.")
    candidates = candidates_of(screening)
    if not candidates:
        raise WorkerError("오늘의 후보 표가 비어 있습니다.")
    return {"market": report.market, "day": f"{day:%Y-%m-%d}", "candidates": candidates}


def guard(candidates: list[dict], ai_picks: list[dict] | None, research: dict | None,
          warnings_of: Callable[[str], list[str]], top: int = 3) -> dict:
    """선정 Guard → {"picks": [...], "filtered": [...]} (순수 함수. 투자유의 조회 warnings_of를 주입한다).

    검사 순서: AI 순위(있으면) → 규칙 점수 순 후보로 채움. 종목마다 후보 밖 → 투자유의(조회 실패도 제외) →
    고위험 공시(filing_screen_agent severity high) → 같은 테마(news_screen_agent theme, 공백 정리·소문자 비교) 3개째.
    조사 결과가 없으면(Fallback 등) 공시·테마 검사는 건너뛴다. 투자유의는 늘 본다. top개가 되면 멈춘다.
    picks는 후보 표의 값 그대로에 aiRank·aiReason·theme·filledByRule(AI 순위가 아니라 규칙 점수 순으로 들어옴)을 더한다.
    """
    pool = {c["symbol"]: c for c in candidates_of({"candidates": candidates})}
    news, filings = _items((research or {}).get(NEWS)), _items((research or {}).get(FILING))
    order = [(p["symbol"], p) for p in _ranked(ai_picks)]
    order += [(c["symbol"], None) for c in sorted(pool.values(), key=_score, reverse=True)]
    picks, filtered, seen, themes = [], [], set(), Counter()
    for symbol, ai in order:
        if len(picks) >= max(top, 0):
            break
        if symbol in seen:
            continue
        seen.add(symbol)
        candidate = pool.get(symbol)
        if candidate is None:
            filtered.append(_filtered(symbol, None, "규칙 후보 표에 없는 종목", CANDIDATES))
            continue
        name = candidate.get("name")
        reason, stage = _blocked(symbol, warnings_of, filings.get(symbol))
        theme = _theme(news.get(symbol))
        if reason is None and theme and themes[theme.lower()] >= THEME_LIMIT:
            reason, stage = f"같은 테마({theme})가 이미 {THEME_LIMIT}개", THEME
        if reason is not None:
            filtered.append(_filtered(symbol, name, reason, stage))
            continue
        if theme:
            themes[theme.lower()] += 1
        picks.append({**candidate, "aiRank": ai["rank"] if ai else None, "aiReason": ai["reason"] if ai else None,
                      "theme": theme, "filledByRule": ai is None})
    return {"picks": picks, "filtered": filtered}


def _blocked(symbol: str, warnings_of, filing: dict | None) -> tuple[str | None, str | None]:
    """투자유의·고위험 공시 검사. (제외 사유, 단계) 또는 (None, None)."""
    try:
        labels = [str(label) for label in warnings_of(symbol) or []]
    except Exception:  # 조회 실패: 안전 확인을 못 했으니 통과시키지 않는다 (fail closed)
        return "투자유의 확인 실패", WARNINGS
    if labels:
        return f"투자유의: {', '.join(labels)}", WARNINGS
    if filing and filing.get("severity") == "high":
        signals = [str(s) for s in filing.get("signals") or [] if s]
        return "고위험 공시" + (f": {', '.join(signals)}" if signals else ""), FILINGS
    return None, None


def _ranked(ai_picks) -> list[dict]:
    """AI 선정안 picks를 rank 순으로 (symbol·rank가 없는 항목은 버린다)."""
    picks = [p for p in ai_picks or [] if isinstance(p, dict) and isinstance(p.get("symbol"), str)
             and isinstance(p.get("rank"), int)]
    return sorted(picks, key=lambda p: p["rank"])


def _items(result) -> dict[str, dict]:
    """조사 Worker 결과의 items → {symbol: 항목}."""
    items = result.get("items") if isinstance(result, dict) else None
    return {i["symbol"]: i for i in items or [] if isinstance(i, dict) and isinstance(i.get("symbol"), str)}


def _theme(item: dict | None) -> str | None:
    """테마 이름 (공백을 하나로). 없으면 None. 비교는 소문자로 한다."""
    theme = item.get("theme") if isinstance(item, dict) else None
    theme = " ".join(theme.split()) if isinstance(theme, str) else ""
    return theme or None


def _score(candidate: dict) -> float:
    value = candidate.get("score")
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else float("-inf")


def _filtered(symbol: str, name, reason: str, stage: str) -> dict:
    return {"symbol": symbol, "name": name if isinstance(name, str) else None, "reason": reason, "stage": stage}
