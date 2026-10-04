"""엔진 실행 기록(runs/*.json) → AnalysisRun 색인 (docs/DECISIONS.md 8-4).

실행 기록은 엔진 `cmd_analyze`의 log다: startedAt, strategy, requestedBy, results[]{snapshot, candidates, errors, research,
costUsd, modelResponseError}. 후보(candidates)는 엔진 Candidate를 dataclasses.asdict 한 것(snake_case)에
passed·selected·rejectReasons를 더한 것이다. 엔진 CLI·전략·일일 리포트가 만든 기록도 같이 색인한다.
"""
import json
import logging
import threading
from datetime import date, datetime
from pathlib import Path, PurePosixPath
from zoneinfo import ZoneInfo

from django.db import IntegrityError, transaction
from paper_engine.report import NEWS_PROVIDER

from config import engine

from .models import AnalysisRun, RunFile

KST = ZoneInfo("Asia/Seoul")
RUN_PREFIX = "runs/"

log = logging.getLogger(__name__)
_lock = threading.Lock()


def run_file_of(name: str) -> str:
    return RUN_PREFIX + name


def run_path(run_file: str) -> Path | None:
    """색인의 run_file("runs/<이름>.json") → RUNS_DIR 안의 경로. RUNS_DIR 밖을 가리키면(.., 링크) None."""
    name = PurePosixPath(run_file).name
    if not name.endswith(".json") or run_file != run_file_of(name):
        return None
    base = engine.RUNS_DIR.resolve()
    path = (base / name).resolve()
    return path if path.parent == base else None


def run_file_names() -> set[str]:
    """RUNS_DIR의 실행 기록 파일 이름들."""
    try:
        return {p.name for p in engine.RUNS_DIR.glob("*.json") if p.is_file()}
    except OSError:
        return set()


def refresh() -> int:
    """새 실행 기록만 색인한다. 만든 행 수를 돌려준다. 깨진 파일은 건너뛴다 (파일이 바뀌면 다음에 다시 읽어 본다)."""
    with _lock:
        names = run_file_names()
        if not names:
            return 0
        known = {name: (ok, size, mtime) for name, ok, size, mtime
                 in RunFile.objects.values_list("name", "ok", "size", "mtime_ns")}
        created = 0
        for name in sorted(names):
            path = engine.RUNS_DIR / name
            try:
                stat = path.stat()
            except OSError:
                continue
            seen = known.get(name)
            if seen and (seen[0] or seen[1:] == (stat.st_size, stat.st_mtime_ns)):
                continue
            real = run_path(run_file_of(name))
            if real is None:
                continue
            try:
                data = json.loads(real.read_text(encoding="utf-8"))
                fallback = datetime.fromtimestamp(stat.st_mtime, KST)
                rows, ok = parse(data, run_file_of(name), fallback), True
            except (OSError, ValueError, TypeError, KeyError, AttributeError) as e:
                log.warning("실행 기록을 읽지 못해 건너뜀: %s (%s)", name, type(e).__name__)
                rows, ok = [], False
            created += _save(name, stat, ok, rows)
        return created


def _save(name: str, stat, ok: bool, rows: list[dict]) -> int:
    try:
        with transaction.atomic():
            made = 0
            for row in rows:
                _, new = AnalysisRun.objects.get_or_create(run_file=row["run_file"], symbol=row["symbol"], defaults=row)
                made += new
            RunFile.objects.update_or_create(name=name, defaults={"size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
                                                                  "ok": ok})
            return made
    except IntegrityError:  # 다른 프로세스가 같은 파일을 동시에 색인했다
        return 0


def parse(data: dict, run_file: str, fallback: datetime) -> list[dict]:
    """실행 기록 하나 → AnalysisRun 행 값들 (종목마다 하나)."""
    if not isinstance(data, dict):
        raise ValueError("실행 기록이 객체가 아님")
    analyzed_at = _time(data.get("startedAt")) or fallback
    strategy = data.get("strategy")
    if isinstance(strategy, dict) and strategy.get("id") is not None:
        requested_by = f"strategy:{strategy['id']}"
    else:
        requested_by = _text(data.get("requestedBy"))
    rows = []
    for entry in data.get("results") or []:
        if not isinstance(entry, dict):
            continue
        snap = entry.get("snapshot") if isinstance(entry.get("snapshot"), dict) else {}
        symbol = (_text(snap.get("symbol")) or "").strip()
        if not symbol:
            continue
        currency = snap.get("currency") if snap.get("currency") in ("KRW", "USD") else None
        market = snap.get("marketCountry") if snap.get("marketCountry") in ("KR", "US") else None
        market = market or ("US" if currency == "USD" else "KR")
        scenarios = scenarios_of(entry)
        candidates = [c for c in entry.get("candidates") or [] if isinstance(c, dict)]
        rows.append({
            "run_file": run_file, "symbol": symbol[:20], "name": (_text(snap.get("name")) or symbol)[:200],
            "market": market, "currency": currency or ("KRW" if market == "KR" else "USD"),
            "analyzed_at": analyzed_at,
            "verdict": AnalysisRun.BUY if any(c.get("selected") is True for c in candidates) else AnalysisRun.PASS,
            "price_at_analysis": _num(snap.get("lastPrice")), "best": pick_best(scenarios),
            "scenario_count": len(scenarios), "requested_by": requested_by[:200] if requested_by else None,
            "cost_usd": _num(entry.get("costUsd")),
        })
    return rows


def scenarios_of(entry: dict) -> list[dict]:
    """results 항목의 후보들 → docs/API.md Scenario 목록. 가격을 알 수 없는 후보는 뺀다."""
    out = []
    for c in entry.get("candidates") or []:
        if isinstance(c, dict) and (view := scenario_view(c)) is not None:
            out.append(view)
    return out


def scenario_view(c: dict) -> dict | None:
    """후보 하나 → Scenario. 시나리오는 final(합의 확률 반영)이 있으면 그것, 없으면 scenario.

    사실 검증에서 떨어진 후보는 scenario가 없으므로 AI가 낸 원래 제안(raw, camelCase)의 가격을 쓰고 점수는 null이다.
    """
    final = c.get("final") if isinstance(c.get("final"), dict) else None
    s = final or (c.get("scenario") if isinstance(c.get("scenario"), dict) else None)
    if s is not None:
        prices = s.get("entry_price"), s.get("target_price"), s.get("stop_price")
        days, rationale, invalidation = s.get("holding_days"), s.get("rationale"), s.get("invalidation")
        score = _num(c.get("score"))
    else:
        raw = c.get("raw") if isinstance(c.get("raw"), dict) else {}
        prices = raw.get("entryPrice"), raw.get("targetPrice"), raw.get("stopPrice")
        days, invalidation, score = raw.get("holdingDays"), raw.get("invalidation"), None
        rationale = [r.get("claim") if isinstance(r, dict) else r for r in _list(raw.get("rationale"))]
    entry_price, target, stop = (_num(p) for p in prices)
    days = _int(days)
    if entry_price is None or target is None or stop is None or days is None:
        return None
    probability = c.get("consensus_probability")
    if probability is None and final is not None:
        probability = final.get("probability")
    reasons = c.get("rejectReasons")
    if not isinstance(reasons, list):  # 예전 기록
        assessment = c.get("assessment") if isinstance(c.get("assessment"), dict) else {}
        reasons = _list(c.get("fact_errors")) + _list(assessment.get("reasons"))
    return {
        "proposer": _text(c.get("proposer")) or "",
        "selected": c.get("selected") is True,
        "passed": c.get("passed") if isinstance(c.get("passed"), bool) else None,
        "score": score,
        "probability": _num(probability),
        "entryPrice": entry_price, "targetPrice": target, "stopPrice": stop,
        "holdingDays": days,
        "rationale": [str(r) for r in _list(rationale) if r],
        "invalidation": _text(invalidation) or "",
        "rejectReasons": [str(r) for r in reasons],
    }


def pick_best(scenarios: list[dict]) -> dict | None:
    """대표 시나리오: 승인된 것 중 최고 점수, 없으면 전체 중 최고 점수. 같은 점수면 앞의 것."""
    pool = [s for s in scenarios if s["selected"]] or scenarios
    if not pool:
        return None
    return max(pool, key=lambda s: s["score"] if s["score"] is not None else float("-inf"))


def load_entry(run_file: str, symbol: str) -> dict | None:
    """실행 기록 파일에서 그 종목의 results 항목. 파일이 없거나 깨졌으면 None."""
    path = run_path(run_file)
    if path is None:
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    for entry in data.get("results") or []:
        if isinstance(entry, dict) and isinstance(entry.get("snapshot"), dict) \
                and (_text(entry["snapshot"].get("symbol")) or "").strip() == symbol:
            return entry
    return None


def details(entry: dict) -> dict:
    """results 항목 → AnalysisDetail의 scenarios·news·newsItems·newsProvider·dataAsOf·research·indicators·errors."""
    snap = entry.get("snapshot") if isinstance(entry.get("snapshot"), dict) else {}
    items = news_items(snap)
    research_log = entry.get("research") if isinstance(entry.get("research"), dict) else {}
    names = research_log.get("researchers") if isinstance(research_log.get("researchers"), dict) else {}
    web = snap.get("webResearch") if isinstance(snap.get("webResearch"), dict) else {}
    research = []
    for r in _list(web.get("researchers")):
        if not isinstance(r, dict):
            continue
        rid = _text(r.get("id")) or ""
        research.append({
            "researcher": _text(names.get(rid)) or rid,  # 실행 기록에는 R1 → 모델 이름이 남아 있다
            "findings": [{"claim": _text(f.get("claim")) or "", "direction": _text(f.get("direction")),
                          "date": _text(f.get("date")), "sourceTitle": _text(f.get("sourceTitle"))}
                         for f in _list(r.get("findings")) if isinstance(f, dict)],
        })
    indicators = snap.get("indicators") if isinstance(snap.get("indicators"), dict) else {}
    errors = [f"모델 응답 에러: {entry['modelResponseError']}"] if entry.get("modelResponseError") else []
    errors += [str(e) for e in _list(entry.get("errors"))]
    return {
        "scenarios": scenarios_of(entry),
        "news": [n["title"] for n in items],
        "newsItems": items,
        "newsProvider": NEWS_PROVIDER,
        "dataAsOf": data_as_of(snap),
        "research": research,
        "indicators": {str(k): v for k, v in indicators.items()
                       if v is None or (isinstance(v, (int, float, str)) and not isinstance(v, bool))},
        "errors": errors,
    }


def news_items(snap: dict) -> list[dict]:
    """스냅샷 뉴스 → [{"title", "source", "publishedAt"}] (U12 약관 대응. 링크는 내지 않는다).

    news(제목만)와 같은 항목·같은 순서다. 게시 시각은 한국 시간 ISO로 바꾸고, 읽지 못하면 null.
    """
    out = []
    for n in _list(snap.get("news")):
        if not isinstance(n, dict) or not n.get("title"):
            continue
        published = _time(n.get("publishedAt"))
        out.append({"title": str(n["title"]), "source": _text(n.get("source")) or None,
                    "publishedAt": published.astimezone(KST).isoformat() if published else None})
    return out


def data_as_of(snap: dict) -> str | None:
    """지표·일봉 자료의 기준일 = 스냅숏의 lastCandleDate (정규장이 끝난 마지막 봉 날짜). 형식이 아니면 None."""
    value = snap.get("lastCandleDate")
    if not isinstance(value, str):
        return None
    try:
        return f"{date.fromisoformat(value[:10])}" if len(value) >= 10 else None
    except ValueError:
        return None


def _time(text) -> datetime | None:
    if not isinstance(text, str):
        return None
    try:
        value = datetime.fromisoformat(text)
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=KST)


def _num(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def _int(value) -> int | None:
    number = _num(value)
    return int(number) if number is not None else None


def _text(value) -> str | None:
    return None if value is None else str(value)


def _list(value) -> list:
    return value if isinstance(value, list) else []
