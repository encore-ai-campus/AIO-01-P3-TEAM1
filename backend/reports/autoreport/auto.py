"""자동 리포트의 하루 파이프라인 (docs/design/AI_AGENT_WORKFLOW.md 1·4·5장, docs/tasks/01-인프라.md T1-3~T1-6).

    규칙 선별(select) → AI 선정 팀(Report team=stock_selection) → 선정 Guard(selection.py)
    → 종목 리포트(request) → 발송(after_finish) → (손익비 기준을 넘는 추천이 없으면) 다음 종목으로 다시 시도(최대 2번) → 표지

그날 결과는 파일 하나에 쌓인다 (DB 아님):

    PAPER_ROOT/runs/screening/<YYYY-MM-DD>-<market>.json   (KST 날짜, docs/API.md ScreeningResult 형식)

- candidates: 규칙을 통과한 후보 전부 (점수 순, 최대 30. select가 늘 채운다). 선정 팀이 보는 후보 표다.
- selection {"reportId", "status": running|done, "top"}: 선정 팀 실행. selectedBy "ai"|"rule"|null(아직 선정 중)과
  fallbackReason(규칙으로 골랐을 때의 사유 코드), aiPicks(AI 선정안 원문), filtered(선정 Guard가 뺀 종목).
- picks: 선정 중에는 규칙 상위 top개(시연 추천과 호환), 선정이 끝나면 선정 Guard를 거친 최종 종목.
- reportIds는 자동 리포트 신청(request)이, recommendationIds는 끝난 리포트의 추천(after_finish)과 시연 자동 추천(autotrade.recommend.auto)이,
  coverSent는 그날 리포트가 모두 끝나 표지를 보냈는지.
- retries: 다시 시도한 횟수(0~RETRY_ROUNDS). 그날 리포트가 모두 끝났는데 손익비가 스윙 기준(리스크 엔진 LIMITS) 이상인 추천이 없으면
  이미 리포트한 종목·선정 Guard가 뺀 종목을 빼고 같은 선정 Guard로 다음 top개를 골라(retryRound 표시) picks에 더해 다시 신청한다
  (같은 종목은 다시 내도 목표가가 거의 같다 — docs/DECISIONS.md 22장). 마지막 회차가 끝나면 표지를 보낸다.

screen_market은 증권사 조회를 100번 넘게 한다 (거래대금 순위·종목 정보·후보마다 일봉). 하루 한 번만, 장 시작 전에 부른다.
엔진 루프의 "자동 리포트" 단계가 tick을, runner가 리포트가 끝날 때마다 after_finish를 부른다. 둘 다 예외를 밖으로 내지 않는다.
파일 읽기-고치기-쓰기는 잠금(스레드 + 잠금 파일) 안에서 한다 (엔진 루프와 runner 스레드, 관리 명령이 겹치지 않게).
"""
import json
import logging
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone
from paper_engine.__main__ import screen_market
from paper_engine.agents.executor import OrderLock
from paper_engine.judge.risk import LIMITS
from trading import market

from config import engine
from config.api import Unavailable

from . import conf, selection
from ..guardrails import contracts
from ..output import pdf, text
from ..models import Report
from ..payloads import conclusion

logger = logging.getLogger(__name__)

KST = ZoneInfo("Asia/Seoul")
MARKET = "KR"            # 매일 자동 선정하는 시장 (US는 manage.py auto_report --market US로만)
MARKETS = ("KR", "US")   # 진행 중인 선정을 이어 갈 시장
SCREEN_CANDIDATES = 30  # 규칙 점수를 매길 거래대금 상위 후보 수 (엔진 전략의 기본값과 같다)
SELECTION_NAME = "오늘의 매매 종목 선정"   # 선정 팀 실행 행의 name (symbol은 시장 코드)
RUNNING, DONE = "running", "done"         # selection.status
AI, RULE = "ai", "rule"                   # selectedBy
NO_CANDIDATES = "no_candidates"
# fallbackReason: 실패 사유 코드(docs/tasks/00-공통.md 9절) + 규칙 후보 0개
FALLBACK_REASONS = ("join_blocked", "review_failed", "timeout", "engine_restarted", "exception", "agent_failed",
                    "no_llm", "expired", NO_CANDIDATES)
SELECTOR = "selector_agent"
RESEARCH = (selection.NEWS, selection.FILING)
RETRY_ROUNDS = 2   # 손익비 기준을 넘는 추천이 없을 때 다음 종목으로 다시 낼 수 있는 횟수 (docs/DECISIONS.md 22장)


def _dir():
    return engine.RUNS_DIR / "screening"


def _path(market_: str, day: date):
    return _dir() / f"{day:%Y-%m-%d}-{market_}.json"


def _skip_path(market_: str, day: date):
    return _dir() / f"{day:%Y-%m-%d}-{market_}.skip.json"


def locked() -> OrderLock:
    """선별 파일 잠금 (같은 스레드는 다시 잡을 수 있다. 다른 프로세스와는 잠금 파일로 묶는다)."""
    return OrderLock.for_path(_dir() / ".lock")


def select(market: str = "KR", top: int = 3, now: datetime | None = None) -> dict:
    """거래대금 상위 후보를 규칙으로 점수 매겨 점수 순 상위 top개를 고르고 그날 파일에 저장한다. 증권사 키가 없으면 Unavailable.

    규칙을 통과한 후보 전부(점수 순)는 candidates에 남긴다 (선정 팀이 보는 후보 표).
    """
    if engine.broker_client() is None:
        raise Unavailable("증권사 조회 키가 없어 선별할 수 없습니다.")
    now = now or timezone.now()
    found = screen_market(engine.engine_config(), market, candidates=max(SCREEN_CANDIDATES, top))
    ranked = sorted(found.get("picks") or [], key=lambda p: p.get("score", 0), reverse=True)
    result = found | {"market": market, "at": now.astimezone(KST).isoformat(), "picks": ranked[:max(top, 0)],
                      "candidates": ranked[:max(SCREEN_CANDIDATES, top)], "reportIds": [], "recommendationIds": []}
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


# --- 하루 파이프라인 (엔진 루프의 "자동 리포트" 단계) ---

def trading_day(market_: str, now: datetime) -> bool:
    """오늘(KST)에 정규장이 있나 (장 달력 기준. 휴장일이면 False). 증권사 조회가 안 되면 Unavailable."""
    day = now.astimezone(KST).date()
    return any(start.astimezone(KST).date() == day for start, _ in market.sessions(market_))


def skipped(market_: str, day: date) -> bool:
    """그날 선별을 건너뛰었나 (건너뜀 표시 파일)."""
    return _skip_path(market_, day).exists()


def tick(now: datetime, log) -> int:
    """엔진 루프의 "자동 리포트" 단계 (매 바퀴, 멱등). 이번에 신청한 종목 리포트 수를 돌려준다. 예외를 밖으로 내지 않는다.

    1) 진행 중인 선정(오늘·어제 파일, KR·US)은 AUTO_REPORT와 상관없이 끝났는지 보고 다음 단계(advance)로 —
       `manage.py auto_report`로 시작한 것, 자정을 넘겨 끝난 것도 버려지지 않게.
    2) 새 선정(단계 A)은 AUTO_REPORT가 on이고 증권사 조회가 되며 KST AUTO_REPORT_AT 이후·국내 거래일·건너뜀 표시 없음일 때 하루 한 번.
       증권사 조회 키가 없으면 조용히 넘어간다 (매일 건너뜀 알림을 보내지 않게).
    """
    made = _advance_running(now, log)
    if not conf.auto_report() or engine.broker_client() is None:
        return made
    day = now.astimezone(KST).date()
    try:
        if isinstance((load(MARKET, day) or {}).get("selection"), dict):
            return made
        if now.astimezone(KST).time() < conf.auto_report_at() or skipped(MARKET, day):
            return made
        try:
            if not trading_day(MARKET, now):
                return made
        except Exception as e:  # 장 달력도 못 읽으면 선별도 못 한다: 그날은 건너뛴다
            _skip(MARKET, day, now, _error_text(e), log)
            return made
        start(MARKET, conf.auto_report_top(), now, log)
    except Exception as e:  # 한 바퀴의 실패가 엔진 루프를 멈추지 않게 (다음 바퀴에 다시 본다)
        logger.exception("자동 리포트 단계 실패")
        log(f"[자동 리포트] {day} {MARKET} 단계 실패: {_error_text(e)}")
    return made


def _advance_running(now: datetime, log) -> int:
    """오늘·어제(KST) 선별 파일 중 선정이 진행 중인 것을 advance. 신청한 종목 리포트 수의 합."""
    today = now.astimezone(KST).date()
    made = 0
    for market_ in MARKETS:
        for day in (today - timedelta(days=1), today):
            try:
                current = (load(market_, day) or {}).get("selection")
                if isinstance(current, dict) and current.get("status") == RUNNING:
                    made += advance(market_, day, log, now=now)
            except Exception as e:  # 한 파일의 문제가 다른 날·시장을 막지 않게
                logger.exception("자동 리포트 선정 진행 실패")
                log(f"[자동 리포트] {day} {market_} 선정 진행 실패: {_error_text(e)}")
    return made


def start(market_: str, top: int, now: datetime, log) -> dict | None:
    """단계 A: 그날 후보 표를 정하고 선정 팀 실행(Report team=stock_selection)을 신청한다. 그날 선별 결과를 돌려준다.

    이미 선정을 시작했으면 그대로 돌려준다. 그날 파일이 있으면 그것을(자동 추천이 먼저 선별했으면), 없으면 select.
    선별이 실패하면(증권사 조회 불가 등) 건너뜀 표시를 남기고 팀 채널에 한 번 알리고 None — 그날은 다시 하지 않는다.
    후보가 0개면 선정 팀 없이 selectedBy rule · fallbackReason no_candidates로 끝낸다.
    """
    day = now.astimezone(KST).date()
    with locked():
        result = load(market_, day)
        if result is not None and isinstance(result.get("selection"), dict):
            return result
        if result is None:
            try:
                result = select(market_, top, now)
            except Exception as e:  # 증권사 조회 불가 등: 그날 선별 건너뜀, 담당자 알림
                _skip(market_, day, now, _error_text(e), log)
                return None
        candidates = selection.candidates_of(result)
        result |= {"candidates": candidates, "reportIds": result.get("reportIds") or [],
                   "recommendationIds": result.get("recommendationIds") or [],
                   "coverSent": bool(result.get("coverSent")), "aiPicks": [], "filtered": []}
        if not candidates:
            result |= {"selection": {"reportId": None, "status": DONE, "top": top}, "selectedBy": RULE,
                       "fallbackReason": NO_CANDIDATES, "picks": []}
            save(result)
            log(f"[자동 리포트] {day} {market_} 규칙 후보가 없어 오늘은 리포트하지 않음")
            _send_cover(result)
            return result
        report = _selection_report(market_, day, now)
        result |= {"selection": {"reportId": report.id, "status": RUNNING, "top": top}, "selectedBy": None,
                   "fallbackReason": None}
        save(result)
    log(f"[자동 리포트] {day} {market_} 후보 {len(candidates)}개 → 선정 팀 실행 #{report.id} 신청")
    return result


def advance(market_: str, day: date, log, top: int | None = None, now: datetime | None = None) -> int:
    """단계 B: 선정 팀 실행이 끝났으면 선정 Guard로 최종 종목을 정하고 종목 리포트를 신청한다. 신청한 수를 돌려준다.

    completed면 AI 선정안(selector_agent)을, failed(또는 행이 없음)면 규칙 점수 순을 Guard에 넣는다 (Fallback — AI를 다시 부르지 않는다).
    조사 결과(뉴스·공시)는 실패한 실행이어도 계약을 통과해 남은 것이 있으면 쓴다. 아직 끝나지 않았으면 아무것도 하지 않는다.
    """
    with locked():
        result = load(market_, day)
        current = (result or {}).get("selection")
        if not isinstance(current, dict) or current.get("status") != RUNNING:
            return 0
        report = Report.objects.filter(pk=current.get("reportId")).first() if current.get("reportId") else None
        if report is not None and report.status not in Report.FINISHED:
            return 0
        top = conf.clamp_top(top or _positive_int(current.get("top")) or conf.auto_report_top())
        results = report.results if report is not None and isinstance(report.results, dict) else {}
        ai_picks, reason = _ai_picks(report, results)
        guarded = selection.guard(selection.candidates_of(result), ai_picks, _research_of(results), market.warnings, top)
        result |= {"selectedBy": RULE if ai_picks is None else AI, "fallbackReason": reason, "aiPicks": ai_picks or [],
                   "picks": guarded["picks"], "filtered": guarded["filtered"]}
        made = request(result, now=now)
        result["selection"] = {**current, "status": DONE}
        save(result)
        names = ", ".join(f"{p.get('name') or p['symbol']}({p['symbol']})" for p in result["picks"]) or "없음"
        how = "AI 선정" if ai_picks is not None else f"규칙 선정(사유 {reason})"
        log(f"[자동 리포트] {day} {market_} {how} → {names} · 선정 Guard 제외 {len(guarded['filtered'])}개 · "
            f"종목 리포트 {len(made)}개 신청")
        if not result.get("reportIds"):  # 기다릴 리포트가 없다: 표지를 지금 보낸다
            _send_cover(result)
        return len(made)


def request(result: dict, now: datetime | None = None) -> list[Report]:
    """선별 결과의 picks마다 자동 종목 리포트(source auto, 신청자 없음, 장애 주입 없음)를 신청하고 reportIds를 채워 파일을 갱신한다.

    그날(파일 날짜, KST) 같은 시장·종목의 자동 종목 리포트가 이미 있으면 새로 만들지 않는다 (그 id는 reportIds에 넣는다).
    새로 만든 리포트만 돌려준다.
    """
    now = now or timezone.now()
    day = datetime.fromisoformat(result["at"]).astimezone(KST).date()
    begin = datetime.combine(day, time.min, KST)
    market_ = result["market"]
    ids, made = list(result.get("reportIds") or []), []
    with locked():
        for pick in result.get("picks") or []:
            symbol = pick.get("symbol") if isinstance(pick, dict) else None
            if not isinstance(symbol, str) or not symbol:
                continue
            report = (Report.objects.filter(source=Report.AUTO, team=Report.STOCK_REPORT, market=market_, symbol=symbol,
                                            created_at__gte=begin, created_at__lt=begin + timedelta(days=1))
                      .order_by("id").first())
            if report is None:
                report = Report.objects.create(source=Report.AUTO, team=Report.STOCK_REPORT, user=None, chaos=None,
                                               symbol=symbol, name=str(pick.get("name") or symbol), market=market_,
                                               created_at=now)
                made.append(report)
            if report.id not in ids:
                ids.append(report.id)
        result["reportIds"] = ids
        save(result)
    return made


def _selection_report(market_: str, day: date, now: datetime) -> Report:
    """그날 선정 팀 실행 행. 이미 있으면(파일이 지워졌어도) 그것을, 없으면 새로 만든다 (requested — runner가 실행한다)."""
    begin = datetime.combine(day, time.min, KST)
    found = (Report.objects.filter(source=Report.AUTO, team=Report.STOCK_SELECTION, market=market_,
                                   created_at__gte=begin, created_at__lt=begin + timedelta(days=1))
             .order_by("-id").first())
    return found or Report.objects.create(source=Report.AUTO, team=Report.STOCK_SELECTION, user=None, chaos=None,
                                          symbol=market_, name=SELECTION_NAME, market=market_, created_at=now)


def _research_of(results: dict) -> dict:
    """선정 팀 실행 결과 중 선정 Guard가 읽는 조사 결과(뉴스·공시). 실패한 실행이어도 남은 것은 쓴다."""
    return {wid: results[wid] for wid in RESEARCH if isinstance(results.get(wid), dict)}


def _ai_picks(report: Report | None, results: dict) -> tuple[list[dict] | None, str | None]:
    """(AI 선정안 picks 또는 None, Fallback 사유 코드 또는 None). completed인데 선정안이 계약에 맞지 않으면 exception."""
    if report is not None and report.status == Report.COMPLETED:
        try:
            draft = contracts.validate("SelectionDraft", results.get(SELECTOR))
        except contracts.ContractError:
            return None, "exception"
        return [{key: pick[key] for key in ("symbol", "rank", "reason", "evidence")} for pick in draft["picks"]], None
    from ..output.alerts import failure_reason  # 마지막 workflow_failed.details.reason

    reason = failure_reason(report) if report is not None else None
    return None, reason if reason in FALLBACK_REASONS else "exception"


def _skip(market_: str, day: date, now: datetime, error: str, log) -> None:
    """그날 선별 건너뜀 표시를 남기고 팀 채널에 한 번 알린다 (표시가 있으면 그날 다시 하지 않는다)."""
    path = _skip_path(market_, day)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"market": market_, "day": f"{day}", "at": now.isoformat(), "error": error},
                               ensure_ascii=False), encoding="utf-8")
    log(f"[자동 리포트] {day} {market_} 선별 실패 (오늘은 다시 하지 않음): {error}")
    _safely(lambda: engine.notifier().send(f"자동 리포트: {day} {market_} 선별을 건너뜁니다 (오늘은 다시 하지 않음) — {error}"))


# --- 끝난 리포트 발송 (runner가 리포트마다 부른다) ---

def after_finish(report) -> None:
    """runner가 끝난 리포트마다 부른다. 자동 종목 리포트만 팀 채널(Discord)로 보낸다. 예외를 밖으로 내지 않는다.

    - 팀원 리포트(source user)·선정 팀 실행(stock_selection — tick이 처리)은 아무것도 하지 않는다.
    - completed: 쉬운 판 A4 PDF(Chrome이 없으면 HTML — docs/DECISIONS.md 20장)를 만들어 pdf_path에 남기고 send_file(한 줄 요약),
      자세한 판 PDF도 만들어 둔다. 추천이 생기면(from_report) 그 id를
      그날 파일 recommendationIds에 더한다 (추천 알림은 from_report가 팀 전체에 보낸다).
    - failed: "자동 리포트 실패: 이름(코드) — 사유 문장" 한 번.
    - 그날 reportIds가 모두 끝났으면: 손익비 기준을 넘는 추천이 없으면 다음 종목으로 다시 시도하고(_retry, 최대 RETRY_ROUNDS번),
      아니면 선별 요약 표지(HTML)를 한 번 보낸다 (coverSent).
    """
    try:
        report = Report.objects.filter(pk=getattr(report, "pk", None)).first()
        if (report is None or report.source != Report.AUTO or report.team != Report.STOCK_REPORT
                or report.status not in Report.FINISHED):
            return
        notifier = engine.notifier()
        recommendation = None
        if report.status == Report.COMPLETED:  # 한 부분의 실패가 나머지(추천·그날 파일·표지)를 막지 않게 따로 감싼다
            _safely(_send_report, report, notifier)
            recommendation = _safely(_recommend, report)
        else:
            _safely(_send_failure, report, notifier)
        _finish_day(report, recommendation)
    except Exception:
        logger.exception("자동 리포트 #%s 마무리 실패", getattr(report, "pk", None))


def _send_report(report: Report, notifier) -> None:
    """완성된 자동 리포트를 팀 채널로: 쉬운 판 PDF(Discord는 쉬운 문장 규칙 — docs/DECISIONS.md 14-7 B6·20장)와 한 줄 요약.

    보낸 뒤 자세한 판 PDF도 만들어 둔다: Chrome은 엔진 컨테이너에만 있어(docs/DECISIONS.md 11장) 웹 컨테이너가 처음 만들면 HTML로 남는다.
    자세한 판을 못 만들어도 로그만 남긴다 (Discord 발송은 이미 끝났다).
    """
    trace = list(report.trace_events.order_by("step"))
    caption = _caption(report, trace)
    try:
        path = pdf.ensure_report_file(report, trace, easy=True)
    except Exception:  # 파일을 못 만들어도 결과는 글로 알린다
        logger.exception("자동 리포트 #%s 파일 만들기 실패", report.id)
        _safely(notifier.send, f"{caption} (파일을 만들지 못했습니다)")
    else:
        try:
            stored = str(path.relative_to(engine.ROOT))
        except ValueError:
            stored = str(path)
        _safely(Report.objects.filter(pk=report.pk).update, pdf_path=stored)   # 화면의 hasPdf (payloads.has_pdf)
        _safely(notifier.send_file, path, caption=caption)
    try:
        pdf.ensure_report_file(report, trace)
    except Exception:
        logger.exception("자동 리포트 #%s 자세한 판 파일 만들기 실패", report.id)


def _send_failure(report: Report, notifier) -> None:
    from ..output.alerts import failure_reason

    notifier.send(f"자동 리포트 실패: {report.name}({report.symbol}) — {text.failure_sentence(failure_reason(report))}")


def _caption(report: Report, trace) -> str:
    """send_file 한 줄: 종목 · AI 의견 · 한 줄 결론 (· 자동 복구 n건)."""
    found = conclusion(report)
    parts = [f"자동 리포트 {report.name}({report.symbol})", text.OPINION_LABEL.get(found["opinion"], "AI 의견 없음")]
    if found["oneLiner"]:
        parts.append(found["oneLiner"])
    recovered = sum(1 for e in trace if e.action == "agent_completed" and isinstance(e.details, dict)
                    and e.details.get("recovered"))
    if recovered:
        parts.append(f"자동 복구 {recovered}건")
    return " · ".join(parts)


def _recommend(report: Report) -> int | None:
    """완성된 자동 리포트의 추천 id (from_report로 만들거나, 엔진 루프의 추천 수집이 먼저 만든 것). 없으면 None."""
    from autotrade.recommend import sources
    from autotrade.models import Recommendation

    found = sources.from_report(report) or Recommendation.objects.filter(report=report).first()
    return found.id if found is not None else None


def _finish_day(report: Report, recommendation: int | None) -> None:
    """그날 파일에 추천 id를 더하고, 그날 리포트가 모두 끝났으면 다시 시도하거나 표지를 보낸다."""
    day = report.created_at.astimezone(KST).date()
    with locked():
        result = load(report.market, day)
        if not result or report.id not in (result.get("reportIds") or []):
            return
        ids = list(result.get("recommendationIds") or [])
        if recommendation is not None and recommendation not in ids:
            result["recommendationIds"] = [*ids, recommendation]
            save(result)
        if not result.get("coverSent") and _all_finished(result) and not _safely(_retry, result, day):
            _send_cover(result)   # 다시 시도가 실패해도 표지는 보낸다 (그 뒤로 이 자리를 부를 리포트가 없다)


def _retry(result: dict, day: date) -> bool:
    """그날 리포트가 모두 끝났을 때: 손익비가 스윙 기준 이상인 추천이 없고 아직 RETRY_ROUNDS번 다 하지 않았으면
    다음 종목 top개로 자동 리포트를 다시 신청한다. 새로 신청했으면 True (표지는 그 회차가 끝난 뒤). 잠금 안에서 부른다.

    그날(KST)이 지났거나, 다음 종목이 없거나, 새로 만든 리포트가 없으면 False.
    """
    retries = _positive_int(result.get("retries")) or 0
    if retries >= RETRY_ROUNDS or timezone.now().astimezone(KST).date() != day or _passing(result):
        return False
    picks = _next_picks(result)
    if not picks:
        return False
    round_ = retries + 1
    result |= {"retries": round_, "picks": [*(result.get("picks") or []), *({**p, "retryRound": round_} for p in picks)]}
    made = request(result)   # 이미 리포트한 종목은 그날 리포트를 그대로 쓰고, 새 종목만 만든다 (파일도 저장한다)
    names = ", ".join(f"{r.name}({r.symbol})" for r in made)
    logger.info("자동 리포트 %s %s 다시 시도 %s/%s → %s", day, result["market"], round_, RETRY_ROUNDS, names or "없음")
    if made:
        _safely(lambda: engine.notifier().send(
            f"자동 리포트 다시 시도 {round_}/{RETRY_ROUNDS}: 손익비 {LIMITS['SWING'].min_reward_risk:g} 이상인 추천이 없어 "
            f"다음 종목으로 다시 만들어요 — {names}"))
    return bool(made)


def _passing(result: dict) -> bool:
    """그날 자동 리포트의 추천 중 손익비(비용 반영)가 스윙 최소 손익비(리스크 엔진 LIMITS) 이상인 것이 있나."""
    from autotrade.models import Recommendation

    ids = [i for i in result.get("reportIds") or [] if isinstance(i, int)]
    return Recommendation.objects.filter(report_id__in=ids,
                                         reward_risk__gte=LIMITS["SWING"].min_reward_risk).exists()


def _next_picks(result: dict) -> list[dict]:
    """다시 시도할 종목: 이미 고른 종목·선정 Guard가 뺀 종목을 빼고 같은 선정 Guard로 top개 (AI 선정안의 남은 순위 → 규칙 점수 순).
    새로 뺀 종목은 filtered에 더한다."""
    used = {p.get("symbol") for p in result.get("picks") or [] if isinstance(p, dict)}
    used |= {f.get("symbol") for f in result.get("filtered") or [] if isinstance(f, dict)}
    candidates = [c for c in selection.candidates_of(result) if c["symbol"] not in used]
    ai_picks = [p for p in result.get("aiPicks") or [] if isinstance(p, dict) and p.get("symbol") not in used]
    current = result.get("selection") if isinstance(result.get("selection"), dict) else {}
    report = Report.objects.filter(pk=current.get("reportId")).first() if current.get("reportId") else None
    results = report.results if report is not None and isinstance(report.results, dict) else {}
    top = conf.clamp_top(_positive_int(current.get("top")) or conf.auto_report_top())
    guarded = selection.guard(candidates, ai_picks, _research_of(results), market.warnings, top)
    result["filtered"] = [*(result.get("filtered") or []), *guarded["filtered"]]
    return guarded["picks"]


def _day_reports(result: dict) -> list[Report]:
    """그날 자동 종목 리포트 (reportIds 순서)."""
    ids = [i for i in result.get("reportIds") or [] if isinstance(i, int)]
    found = {r.id: r for r in Report.objects.filter(pk__in=ids, team=Report.STOCK_REPORT)}
    return [found[i] for i in ids if i in found]


def _all_finished(result: dict) -> bool:
    return all(r.status in Report.FINISHED for r in _day_reports(result))


def _send_cover(result: dict) -> None:
    """그날 리포트(reportIds)가 모두 끝났고 아직 보내지 않았으면 선별 요약 표지(HTML)를 파일로 남겨 한 번 보낸다. 잠금 안에서 부른다."""
    if result.get("coverSent"):
        return
    reports = _day_reports(result)
    if any(r.status not in Report.FINISHED for r in reports):
        return
    day = datetime.fromisoformat(result["at"]).astimezone(KST).date()
    path = _dir() / f"{day:%Y-%m-%d}-{result['market']}.cover.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(pdf.build_screening_html(result, reports), encoding="utf-8")
    result["coverSent"] = True  # 보내다 실패해도 다시 보내지 않는다 (리포트가 끝날 때마다 같은 표지를 보내지 않게)
    save(result)
    how = "AI 선정" if result.get("selectedBy") == AI else "규칙 선정"
    retried = f" (다시 시도 {result['retries']}번)" if _positive_int(result.get("retries")) else ""
    _safely(engine.notifier().send_file, path,
            caption=f"오늘의 자동 리포트 {day} {result['market']} · {how} · 리포트 {len(reports)}개{retried}")


def _safely(func, *args, **kwargs):
    """func를 부르고 결과를 돌려준다. 예외는 로그만 남기고 None (발송·추천 하나의 실패가 나머지를 막지 않게)."""
    try:
        return func(*args, **kwargs)
    except Exception:
        logger.exception("자동 리포트 %s 실패", getattr(func, "__name__", func))
        return None


def _positive_int(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _error_text(e: Exception) -> str:
    return f"{type(e).__name__}: {getattr(e, 'detail', e)}"
