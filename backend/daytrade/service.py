"""단타 연습장: 상태 · 미리 보기 · 계획 만들기 · 계획 목록 (docs/API.md "단타 연습", docs/DECISIONS.md 14-4).

모델이 없다. 단타 계획은 autotrade의 추천·계획을 재사용한다 — 사용자가 입력한 진입·목표·손절로 추천(source day, horizon DAY,
AI 아님)을 만들고 곧바로 활성화한다. 수량·한도는 리스크 엔진의 DAY 한도(autotrade.risk.evaluate), 주문·체결은 trading.service와
모의 체결기, 진행은 엔진 루프의 "자동매매" 단계다. 여기서는 잠금·세션·입력을 검사하고 비용을 계산한다.
"""
import math
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime

from accounts.modes import day_trading_lock
from autotrade import executor, risk, sources
from autotrade.executor import Blocked
from autotrade.models import HORIZON_DAY, Recommendation, TradePlan
from autotrade.text import DAY_CUTOFF_TEXT
from django.db.models import ProtectedError
from paper_engine.data.ticks import round_price
from paper_engine.judge.risk import LIMITS, SELL_TAX_RATE
from trading import market
from trading import service as trading
from trading.models import DAY
from trading.store import AccountStore, account_for

from config import engine
from config.api import Rejected

from .session import cutoff_at, day_bounds, kst_date, session

MARKET, CURRENCY = "KR", "KRW"  # 단타 연습은 국내 종목만 (15:15·15:30 규칙이 국내 장 기준)
HOLDING_DAYS = 1
SUMMARY = "단타 연습 계획 (직접 입력, AI 아님)"
PREVIEW_KEYS = ("symbol", "entryPrice", "targetPrice", "stopPrice", "budgetKrw")
PLAN_KEYS = PREVIEW_KEYS + ("acknowledged",)
PRICE_KEYS = (("entryPrice", "진입가"), ("targetPrice", "목표가"), ("stopPrice", "손절가"))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# 사유 코드 (docs/API.md "실행 불가 사유 코드")
# 문장은 autotrade.risk.evaluate(horizon DAY)가 같은 코드에 쓰는 문장 그대로 (한 곳에서 가져온다)
LOCKED, ENTRY_CLOSED = "day_trading_locked", "day_entry_closed"
LOCKED_TEXT = risk.DAY_LOCKED
ENTRY_CLOSED_TEXT = risk.DAY_ENTRY_CLOSED
NOT_ACKNOWLEDGED = (f"실행 확인 체크리스트(손절 시 손실 · {DAY_CUTOFF_TEXT} 강제 정리 · 비용)를 모두 확인해야 합니다 "
                    "(acknowledged: true).")


@dataclass(frozen=True)
class DayInput:
    """두 POST의 검사한 입력 (가격은 호가 단위로 내려 맞춘 값)."""
    symbol: str
    name: str
    entry: float
    target: float
    stop: float
    budget_krw: float | None


# --- 상태 ---

def limits() -> dict:
    """DayLimits = 리스크 엔진 LIMITS["DAY"]."""
    lim = LIMITS["DAY"]
    return {"riskPerTrade": lim.risk_per_trade, "maxDailyLoss": lim.max_daily_loss,
            "maxDailyTrades": lim.max_daily_trades, "minRewardRisk": lim.min_reward_risk}


def today(user, now: datetime) -> dict:
    """오늘(KST) 낸 단타(style day) 주문 수 · 확정 단타 손실 · 하루 손실 한도 금액 (리스크 엔진이 세는 값과 같다)."""
    account = account_for(user)
    orders, loss = AccountStore(account).paper_today(f"{kst_date(now)}", style=DAY)
    equity = trading.summary(account, now)["equityKrw"]
    return {"orders": orders, "lossKrw": loss, "lossLimitKrw": equity * LIMITS["DAY"].max_daily_loss}


def status(user, now: datetime) -> dict:
    """DayStatus (잠겨도 볼 수 있다)."""
    reasons = day_trading_lock(user)
    return {"unlocked": not reasons, "lockReasons": reasons, "session": session(now), "limits": limits(),
            "today": today(user, now)}


# --- 입력 ---

def _check_locked(user) -> None:
    """잠겨 있으면(주린이모드 켬·퀴즈 미통과) day_trading_locked로 막는다."""
    if day_trading_lock(user):
        raise Blocked([LOCKED_TEXT], [LOCKED])


def _positive(value) -> float | None:
    """JSON 숫자(불리언·숫자 문자열은 아님)이고 유한한 양수면 float, 아니면 None.

    자릿수가 아주 긴 정수(float로 바꾸면 OverflowError)와 JSON의 1e400(inf로 읽힌다)도 None — trading.views._number와 같은 처리.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) and number > 0 else None


def _price(data: dict, key: str, label: str) -> float:
    value = data.get(key)
    if value is None:
        raise Rejected(f"{label}({key})를 입력하세요.")
    number = _positive(value)
    if number is None:
        raise Rejected(f"{label}({key})는 0보다 큰 숫자여야 합니다.")
    return float(round_price(number, CURRENCY))  # 모의 주문에 들어가는 값과 같게 호가 단위로 내린다


def _budget(value) -> float | None:
    if value is None:
        return None
    number = _positive(value)
    if number is None:
        raise Rejected("budgetKrw는 0보다 큰 숫자여야 합니다.")
    return number


def parse(data, allowed: tuple[str, ...]) -> DayInput:
    """symbol(국내 종목) · 진입·목표·손절(양수, 호가 단위로 내린 뒤 0 < 손절 < 진입 < 목표) · budgetKrw(선택, 양수).

    모르는 키·잘못된 값은 400 {"detail"}. 종목 목록을 받지 못하면 503.
    """
    if not isinstance(data, dict):
        raise Rejected("요청 본문은 JSON 객체여야 합니다.")
    unknown = sorted(set(data) - set(allowed))
    if unknown:
        raise Rejected(f"알 수 없는 항목: {', '.join(unknown)}")
    symbol = data.get("symbol")
    if not isinstance(symbol, str) or not symbol.strip():
        raise Rejected("종목코드(symbol)를 입력하세요.")
    item = market.stock_item(symbol)
    if item is None:
        raise Rejected("종목을 찾을 수 없습니다.")
    if item["market"] != MARKET:
        raise Rejected("단타 연습은 국내 종목만 할 수 있습니다.")
    entry, target, stop = (_price(data, key, label) for key, label in PRICE_KEYS)
    if not 0 < stop < entry < target:
        raise Rejected(f"가격은 0 < 손절가 < 진입가 < 목표가 순서여야 합니다 (호가 단위로 맞춘 값: "
                       f"손절 {stop:,.0f} · 진입 {entry:,.0f} · 목표 {target:,.0f}).")
    return DayInput(symbol=item["symbol"], name=item["name"], entry=entry, target=target, stop=stop,
                    budget_krw=_budget(data.get("budgetKrw")))


def _acknowledged(data: dict) -> None:
    if data.get("acknowledged") is not True:
        raise Rejected(NOT_ACKNOWLEDGED)


# --- 미리 보기 ---

def costs(quantity: float, entry: float, exit_price: float) -> dict:
    """TradeCosts: quantity주를 entry에 사서 exit_price에 팔 때의 비용 (원). 모의 체결기와 같은 계산 —
    수수료는 매수·매도 금액 각각 × PAPER_COMMISSION_KR, 거래세는 매도 금액 × 0.20%."""
    rate = engine.engine_config().commission[MARKET]
    commission = (entry + exit_price) * quantity * rate
    tax = exit_price * quantity * SELL_TAX_RATE[MARKET]
    return {"commissionKrw": commission, "taxKrw": tax, "totalKrw": commission + tax}


def _evaluate(user, x: DayInput, now: datetime, live_check: bool) -> dict:
    """리스크 엔진(DAY 한도, 장마감 기준)으로 내 모의 계좌에서 계산한 RiskPreview."""
    return risk.evaluate(user, symbol=x.symbol, name=x.name, market=MARKET, currency=CURRENCY, entry=x.entry,
                         target=x.target, stop=x.stop, holding_days=HOLDING_DAYS, horizon=HORIZON_DAY,
                         budget_krw=x.budget_krw, now=now, live_check=live_check)


def _with_session(found: dict, day_session: dict) -> dict:
    """세션이 계획을 받지 않으면(15:15 이후·휴장일) activatable을 끄고, 리스크 계산이 아직 day_entry_closed를 넣지 않았으면
    사유 맨 앞에 넣는다 (같은 코드를 두 번 넣지 않는다)."""
    reasons, codes = list(found.get("reasons") or []), list(found.get("reasonCodes") or [])
    if not day_session["acceptingPlans"] and ENTRY_CLOSED not in codes:
        reasons, codes = [ENTRY_CLOSED_TEXT, *reasons], [ENTRY_CLOSED, *codes]
    return found | {"reasons": reasons, "reasonCodes": codes,
                    "activatable": bool(found.get("activatable")) and day_session["acceptingPlans"] and not reasons}


def preview(user, data, now: datetime) -> dict:
    """DayPreview = RiskPreview(DAY 한도) + session + 목표·손절에서 팔 때의 비용. 만들 수 없는 시각이어도 200."""
    _check_locked(user)
    x = parse(data, PREVIEW_KEYS)
    day_session = session(now)
    found = _with_session(_evaluate(user, x, now, live_check=False), day_session)
    quantity = found.get("quantity") or 0
    return found | {"session": day_session, "costsAtTarget": costs(quantity, x.entry, x.target),
                    "costsAtStop": costs(quantity, x.entry, x.stop)}


# --- 계획 ---

def _drop(rec: Recommendation) -> None:
    """활성화가 막혀 계획 없이 남은 추천을 지운다 (막히면 추천·계획을 하나도 남기지 않는다)."""
    try:
        if not TradePlan.objects.filter(recommendation=rec).exists():
            rec.delete()
    except ProtectedError:
        pass


def create_plan(user, data, now: datetime) -> TradePlan:
    """단타 계획 만들기 = 추천(source day)을 만들고 곧바로 활성화 (첫 진입 지정가 주문까지).

    ① 입력·실행 확인·잠김 ② 세션과 활성화 점검(미리 보기와 같은 종가 계산, DAY 한도, 정규장 중이면 장중 확인)을 행을 만들기 전에 한다 —
    막히면 autotrade.executor.Blocked(400 {"detail", "reasonCodes"})이고 아무것도 만들지 않는다 ③ 추천(validUntil = 오늘 15:15 KST, 추천 알림 없음)
    ④ autotrade.executor.activate (그 자리에서 진입 주문. 접수가 드문 경합으로 거절되면 계획 failed로 돌아온다).
    """
    x = parse(data, PLAN_KEYS)
    _acknowledged(data)
    _check_locked(user)
    day_session = session(now)
    found = _with_session(_evaluate(user, x, now, live_check=True), day_session)
    if found["reasons"]:
        raise Blocked(found["reasons"], found["reasonCodes"])
    try:
        rec = sources.create(
            Recommendation.DAY, symbol=x.symbol, name=x.name, market_=MARKET, entry=x.entry, target=x.target,
            stop=x.stop, holding_days=HOLDING_DAYS, probability=None, summary=SUMMARY, reasons=[], risks=[],
            requested_by=user, now=now, horizon=HORIZON_DAY, valid_until=cutoff_at(kst_date(now)), announce=False)
    except ValueError as e:
        raise Rejected(str(e)) from None
    try:
        return executor.activate(rec, user, x.budget_krw, "web", now, acknowledged=True)
    except Exception:  # 점검과 활성화 사이의 경합(Blocked — 그사이 같은 종목 계획이 생김 등)·증권사 조회 오류
        _drop(rec)
        raise


def parse_date(text: str | None, default: date, name: str = "date") -> date:
    """YYYY-MM-DD (없으면 default). 형식이 틀리면 400."""
    if text in (None, ""):
        return default
    if not DATE_RE.match(text):
        raise Rejected(f"{name}는 YYYY-MM-DD 형식이어야 합니다.")
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise Rejected(f"{name}가 올바른 날짜가 아닙니다.") from None


def session_plans(user, day: date):
    """그 세션의 내 단타 계획 = horizon DAY이고 진입 기한(entryDeadline)의 KST 날짜(= 만든 날)가 day인 것.

    0001-01-01·9999-12-31처럼 그날 경계(KST 0시~다음 날 0시)를 UTC로 나타낼 수 없는 날은 계획이 있을 수 없으므로 빈 목록이다
    (DB 조회가 OverflowError로 500이 되지 않게 — 형식만 맞으면 200, docs/API.md "단타 연습").
    """
    try:
        start, end = (bound.astimezone(UTC) for bound in day_bounds(day))
    except OverflowError:
        return TradePlan.objects.none()
    return (TradePlan.objects.filter(user=user, horizon=HORIZON_DAY, entry_deadline__gte=start,
                                     entry_deadline__lt=end).select_related("recommendation"))
