"""추천 만들기 (docs/DECISIONS.md 12-1·12-2): AI 리포트(report_agent 결과)·AI 교차검증 분석(BUY)·시연 규칙(demo.py).

출처마다 추천은 하나다. 판정이 buy/BUY이고 0 < 손절 < 진입 < 목표일 때만 만든다. 만들면 신청한 팀원(없으면 팀 전체)에게 알린다.
priceAtCreation은 출처와 무관하게 만들 때의 직전 정규장 종가다 (장마감 기준, docs/DECISIONS.md 14-1).
엔진 루프의 "추천 수집" 단계가 collect를 부른다 (끝난 리포트·분석을 추천으로, 기한 지난 추천과 가격이 이미 손절가·목표가를 지난 추천을 만료로).
리포트는 종목 리포트(team "stock_report")만 본다 — 매매 종목 선정 실행(stock_selection)에는 report_agent 결과가 없다.
"""
import math
from datetime import datetime, timedelta

from analysis.models import AnalysisRun
from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.db.models import Q
from django.utils import timezone
from paper_engine.data.ticks import round_price
from reports.guardrails.contracts import MAX_HOLDING_DAYS, MAX_ITEMS, MIN_HOLDING_DAYS, RISK_LEVELS
from reports.models import Report
from trading import market

from config.api import Unavailable

from .. import conf
from ..plans import risk
from .. import text as texts
from ..models import Recommendation
from ..tokens import activation_token

DEFAULT_HOLDING_DAYS = 10
ASSUMED_PROBABILITY = 0.5
REPORT_LOOKBACK, ANALYSIS_LOOKBACK = timedelta(days=7), timedelta(days=3)
INVALIDATE_EVERY = timedelta(minutes=1)  # 가격이 지난 추천 정리 주기 (엔진 루프는 5초마다 돈다)
SOURCE_LABEL = texts.SOURCE_LABEL
COLOR = {Recommendation.REPORT: 0x2E7D32, Recommendation.ANALYSIS: 0x1565C0, Recommendation.DEMO: 0x757575}
_FETCH = object()
_invalidated_at: datetime | None = None  # 마지막으로 가격을 본 시각 (엔진 루프 프로세스 하나에서만 쓴다)


def _price(value, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"{name}이(가) 숫자가 아님: {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{name}이(가) 숫자가 아님: {value!r}")
    return number


def _texts(items) -> list[str]:
    if not isinstance(items, (list, tuple)):
        return []
    return [str(item).strip() for item in items if str(item).strip()][:MAX_ITEMS]


def _holding_days(value) -> int:
    if value is None or isinstance(value, bool):
        return DEFAULT_HOLDING_DAYS
    try:
        days = int(float(value))
    except (TypeError, ValueError):
        return DEFAULT_HOLDING_DAYS
    return min(max(days, MIN_HOLDING_DAYS), MAX_HOLDING_DAYS)


def _probability(value) -> tuple[float, bool]:
    """(확률, 가정했나). 없으면 0.5로 가정한다. 0~1 밖이면 잘못된 값이다."""
    if value is None:
        return ASSUMED_PROBABILITY, True
    p = _price(value, "probability")
    if not 0 <= p <= 1:
        raise ValueError(f"probability는 0~1이어야 함: {p}")
    return p, False


def _confidence(value) -> float | None:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return min(max(float(value), 0.0), 100.0) if math.isfinite(value) else None


def _close_price(symbol: str) -> float | None:
    """직전 정규장 종가 (장마감 기준). 받지 못하면 None."""
    try:
        return market.close_price(symbol)
    except Unavailable:
        return None


def create(source: str, *, symbol: str, name: str, market_: str, entry, target, stop, holding_days=None,
           probability=None, confidence=None, summary: str = "", reasons=(), risks=(), risk_level=None,
           requested_by=None, report: Report | None = None, analysis: AnalysisRun | None = None,
           price_at_creation=_FETCH, now: datetime | None = None, probability_assumed: bool | None = None,
           ) -> Recommendation:
    """값을 검증하고 수치를 채워 추천을 저장한 뒤 알린다. 값이 잘못됐으면 ValueError.

    probability_assumed를 주면 그 값을 쓴다 (시연 추천처럼 확률을 정해 두고 "가정"으로 표시할 때).
    price_at_creation을 주지 않으면 지금의 직전 정규장 종가 (장마감 기준).
    valid_until(활성화 기한이자 진입 기한)은 지금 + RECOMMENDATION_VALID_DAYS일.
    """
    now = now or timezone.now()
    if market_ not in market.CURRENCY:
        raise ValueError(f"시장이 KR·US가 아님: {market_}")
    entry, target, stop = _price(entry, "entry"), _price(target, "target"), _price(stop, "stop")
    # 호가 단위로 맞춘다 (모의 주문과 같은 내림, 엔진 PaperExecutor.buy). 순서·수치는 맞춘 값으로 본다
    currency = market.CURRENCY[market_]
    entry, target, stop = (float(round_price(v, currency)) if v > 0 else v for v in (entry, target, stop))
    if not 0 < stop < entry < target:
        raise ValueError(f"가격은 0 < 손절가 < 진입가 < 목표가 순서여야 함: {stop}, {entry}, {target}")
    p, assumed = _probability(probability)
    if probability_assumed is not None:
        assumed = probability_assumed
    if price_at_creation is _FETCH:
        price_at_creation = _close_price(symbol)
    m = risk.metrics(entry, target, stop, p, market_)
    rec = Recommendation.objects.create(
        source=source, report=report, analysis=analysis, requested_by=requested_by, symbol=symbol, name=name,
        market=market_, currency=currency, price_at_creation=price_at_creation, entry_price=entry,
        target_price=target, stop_price=stop, holding_days=_holding_days(holding_days), probability=p,
        probability_assumed=assumed, confidence=_confidence(confidence), target_return=m["targetReturn"],
        stop_loss_rate=m["stopLossRate"], reward_risk=m["rewardRisk"], expected_return=m["expectedReturn"],
        summary=(summary or "").strip(), reasons=_texts(reasons), risks=_texts(risks),
        risk_level=risk_level if risk_level in RISK_LEVELS else None, status=Recommendation.OPEN,
        valid_until=now + timedelta(days=conf.valid_days()), created_at=now)
    notify_recommendation(rec)
    return rec


# --- 출처별 ---

def from_report(report: Report, now: datetime | None = None) -> Recommendation | None:
    """끝난 종목 리포트의 report_agent 결과(ReportDraft)가 buy이고 목표가가 맞으면 추천. 아니면(이미 있으면·선정 실행이면) None."""
    if report.status != Report.COMPLETED or report.team != Report.STOCK_REPORT or report.deleted_at is not None:
        return None
    if Recommendation.objects.filter(report=report).exists():
        return None
    results = report.results if isinstance(report.results, dict) else {}
    draft = results.get("report_agent")
    if not isinstance(draft, dict) or str(draft.get("verdict", "")).lower() != "buy":
        return None
    targets = draft.get("targets")
    if not isinstance(targets, dict) or None in (targets.get("entry"), targets.get("target"), targets.get("stop")):
        return None
    risk_result = results.get("risk_agent")
    level = risk_result.get("level") if isinstance(risk_result, dict) else None
    try:
        return create(Recommendation.REPORT, symbol=report.symbol, name=report.name, market_=report.market,
                      entry=targets["entry"], target=targets["target"], stop=targets["stop"],
                      holding_days=targets.get("holdingDays"), probability=targets.get("probability"),
                      confidence=draft.get("confidence"), summary=str(draft.get("oneLiner") or ""),
                      reasons=draft.get("reasons"), risks=draft.get("risks"), risk_level=level,
                      requested_by=getattr(report, "user", None), report=report, now=now)
    except ValueError:
        return None
    except IntegrityError:  # 그사이 다른 쪽이 만들었다
        return None


def from_analysis(run: AnalysisRun, now: datetime | None = None) -> Recommendation | None:
    """BUY 분석의 대표 시나리오(best, Scenario 형식)로 추천. 아니면(이미 있으면) None."""
    if run.verdict != AnalysisRun.BUY or Recommendation.objects.filter(analysis=run).exists():
        return None
    best = run.best
    if not isinstance(best, dict) or None in (best.get("entryPrice"), best.get("targetPrice"), best.get("stopPrice")):
        return None
    rationale = _texts(best.get("rationale"))
    invalidation = str(best.get("invalidation") or "").strip()
    user = get_user_model().objects.filter(username=run.requested_by).first() if run.requested_by else None
    try:
        return create(Recommendation.ANALYSIS, symbol=run.symbol, name=run.name, market_=run.market,
                      entry=best["entryPrice"], target=best["targetPrice"], stop=best["stopPrice"],
                      holding_days=best.get("holdingDays"), probability=best.get("probability"),
                      confidence=best.get("score"),
                      summary=rationale[0] if rationale else f"AI 교차검증 분석 BUY · {run.name}",
                      reasons=rationale, risks=[f"시나리오가 틀렸다고 볼 조건: {invalidation}"] if invalidation else [],
                      requested_by=user, analysis=run, now=now)  # priceAtCreation = 만들 때의 종가 (분석 시각 가격 아님)
    except ValueError:
        return None
    except IntegrityError:
        return None


def expire(now: datetime) -> int:
    """validUntil이 지난 open 추천 → expired (까닭 deadline). 바꾼 수를 돌려준다."""
    return Recommendation.objects.filter(status=Recommendation.OPEN, valid_until__lte=now).update(
        status=Recommendation.EXPIRED, expired_reason=Recommendation.DEADLINE)


def passed(price: float, rec: Recommendation) -> str | None:
    """현재가가 이미 손절가 이하면 below_stop, 목표가 이상이면 above_target, 아니면 None."""
    if price <= rec.stop_price:
        return Recommendation.BELOW_STOP
    if price >= rec.target_price:
        return Recommendation.ABOVE_TARGET
    return None


def invalidate(now: datetime, *, force: bool = False) -> int:
    """가격이 이미 손절가 이하·목표가 이상인 open 추천 → expired (docs/API.md "가격이 지난 계획 제안 자동 정리", DECISIONS 25장).

    1분에 한 번만 본다 (force면 지금). 가격은 실시간 시세와 같은 현재가(market.current_prices — 정규장 밖이면 마지막 가격)이고,
    받지 못한 종목은 다음 번에 본다. 다시 open으로 돌리지 않는다. 진행 중 계획은 자기 값으로 그대로 진행한다. 바꾼 수를 돌려준다.
    """
    global _invalidated_at
    if not force and _invalidated_at is not None and timedelta(0) <= now - _invalidated_at < INVALIDATE_EVERY:
        return 0
    _invalidated_at = now
    recs = list(Recommendation.objects.filter(status=Recommendation.OPEN, valid_until__gt=now,
                                              deleted_at__isnull=True))
    if not recs:
        return 0
    try:
        prices = market.current_prices(sorted({rec.symbol for rec in recs}))
    except Unavailable:  # 증권사 키가 없거나 조회 실패 — 다음 번에
        return 0
    changed = 0
    for rec in recs:
        reason = passed(prices[rec.symbol], rec) if rec.symbol in prices else None
        if reason:
            changed += Recommendation.objects.filter(pk=rec.pk, status=Recommendation.OPEN).update(
                status=Recommendation.EXPIRED, expired_reason=reason)
    return changed


def collect(now: datetime, log) -> int:
    """최근 7일 안에 끝난 종목 리포트·최근 3일 BUY 분석 중 추천이 없는 것을 추천으로 만들고 기한 지난 추천과 가격이 지난 추천을 만료한다.

    만든 추천 수를 돌려준다. 한 건의 오류가 나머지를 막지 않는다.
    """
    made = 0
    since = now - REPORT_LOOKBACK
    reports = (Report.objects.filter(Q(finished_at__gte=since) | Q(finished_at__isnull=True, created_at__gte=since),
                                     team=Report.STOCK_REPORT, status=Report.COMPLETED, recommendations__isnull=True,
                                     deleted_at__isnull=True)
               .select_related("user").order_by("id"))
    runs = AnalysisRun.objects.filter(verdict=AnalysisRun.BUY, analyzed_at__gte=now - ANALYSIS_LOOKBACK,
                                      recommendations__isnull=True).order_by("id")
    for label, items, make in (("리포트", reports, from_report), ("분석", runs, from_analysis)):
        for item in items:
            try:
                rec = make(item, now)
            except Exception as e:  # 한 건의 문제가 다른 추천을 막지 않게
                log(f"[추천] {label} #{item.id} 추천을 만들지 못함: {e}")
                continue
            if rec is not None:
                made += 1
                log(f"[추천] {label} #{item.id} → 추천 #{rec.id} {rec.name} ({rec.symbol})")
    expired = expire(now)
    if expired:
        log(f"[추천] 기한 지난 추천 {expired}개 만료")
    passed_ = invalidate(now)
    if passed_:
        log(f"[추천] 가격이 이미 손절가·목표가를 지난 추천 {passed_}개 만료")
    return made


# --- 알림 ---

def title_of(rec: Recommendation) -> str:
    """전문가 제목 ("AI 추천 · 삼성전자 (005930)")."""
    return texts.recommendation(rec).expert_title


def body_of(rec: Recommendation) -> str:
    """전문가 본문 (진입·목표·손절 / 손익비·보유·기대수익률 / 출처·유효 기한 / 한 줄 결론). 리포트 추천이면 첫 줄 "리포트가 완성됐어요"."""
    return texts.recommendation(rec).expert_body


def notify_recommendation(rec: Recommendation) -> None:
    """추천 알림: 신청한 팀원(없으면 팀 전체). Discord에는 서명된 활성화 링크를 넣는다. 알림 실패가 추천을 막지 않는다."""
    c = rec.currency
    notice = texts.recommendation(rec)
    fields = [{"name": "진입가", "value": texts.money(rec.entry_price, c), "inline": True},
              {"name": "목표가", "value": f"{texts.money(rec.target_price, c)} ({texts.pct(rec.target_return)})",
               "inline": True},
              {"name": "손절가", "value": f"{texts.money(rec.stop_price, c)} ({texts.pct(rec.stop_loss_rate)})",
               "inline": True},
              {"name": "손익비", "value": f"{rec.reward_risk:.2f}", "inline": True},
              {"name": "기대수익률", "value": texts.pct(rec.expected_return), "inline": True},
              {"name": "유효 기한", "value": texts.when(rec.valid_until), "inline": True}]
    embed = {"title": notice.title, "description": rec.summary or SOURCE_LABEL[rec.source],
             "color": COLOR[rec.source], "fields": fields}
    try:
        notice.send(rec.requested_by, "recommendation", link=f"/recommendations/{rec.id}",
                    discord_link=f"/recommendations/{rec.id}?t={activation_token(rec)}",
                    link_label="계획 활성화", embed=embed)
    except Exception:  # notify는 예외를 내지 않기로 했지만, 혹시 내도 추천은 남긴다
        pass


announce = notify_recommendation  # 예전 이름
