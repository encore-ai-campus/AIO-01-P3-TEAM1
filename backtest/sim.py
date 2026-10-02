"""백테스트 시뮬레이션. AI를 부르지 않고 파이프라인의 코드 단계를 과거 일봉으로 재현한다.

하루의 흐름 (거래일 D):
  1. 정규장 전 선별: D 전날까지의 일봉으로 거래대금 상위 → 규칙 점수(judge/screen.py) → 상위 N개
  2. 시나리오: AI 분석가 대신 규칙으로 만든다 (진입 = 전일 종가, 목표·손절 = ATR 배수)
  3. 사실 검증(보유 기간, 진입가 괴리)과 리스크 엔진(judge/risk.py)을 그대로 통과해야 한다
  4. 실행 (agents/executor.py 규칙): 진입가 지정가 DAY 주문. D에 체결되지 않으면 취소
     체결 후 목표·손절 감시. 손절은 감시가에 닿으면 손절 주문가(감시가 −1%)로 판다고 본다
     보유 기한(달력 날짜)이 지나면 다음 거래일 시가에 판다

일봉만 보므로 애매하면 불리한 쪽으로 본다 (records/paper.py와 같은 원칙).
  - 같은 봉에서 손절과 목표가 모두 닿으면 손절
  - 장중에 체결된 날은 목표가 도달을 인정하지 않는다 (체결 전 고가일 수 있음)
  - 시가가 손절가 이하나 목표가 이상으로 갭이 나면 시가에 판다

실험용 훅 (기본값이면 운영 규칙과 같다):
  - Settings.entry_mode: "limit"(전일 종가 지정가) | "open"(시가 시장가) | "limit_below"(전일 종가 − ATR × entry_offset_atr)
  - Settings.fill_window_days: 지정가 주문이 살아 있는 거래일 수 (운영은 DAY = 1)
  - Settings.max_positions: 동시 보유 종목 수 상한
  - Settings.risk_limits: 리스크 엔진의 SWING 한도 재정의 (judge/risk.RiskLimits)
  - Rule.trailing_atr: 체결 후 최고가 − ATR × 이 값으로 손절 감시가를 올린다 (전날까지의 고가만 본다)
  - Backtest(screen_fn=, scenario_fn=, regime_fn=): 선별 함수, 시나리오 가격 함수, 시장 체제 필터
"""
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta

from paper_engine.data import indicators
from paper_engine.data.snapshot import LIQUIDITY_DAYS
from paper_engine.data.ticks import round_price
from paper_engine.judge import risk, screen
from paper_engine.judge.fact_check import fact_check
from paper_engine.judge.risk import SELL_TAX_RATE, STOP_LIMIT_BUFFER, AccountContext, RiskLimits, assess
from paper_engine.judge.scenario import Scenario

SCREEN_CANDLES = 130  # 운영 선별과 같은 일봉 수
RANK_COUNT = 100  # 거래대금 랭킹 상위 몇 개에서 고르는지 (API 최대)

TARGET, STOP, EXPIRED, UNFILLED, OPEN = "TARGET", "STOP", "EXPIRED", "UNFILLED", "OPEN"

# 훅 형식
ScreenFn = Callable[[str, str, list[dict], float], "screen.Pick | str"]  # (종목, 이름, 일봉, 거래대금)
ScenarioFn = Callable[[list[dict], "Rule", float], tuple[float, float, float] | None]  # (일봉, 규칙, ATR) → (진입, 목표, 손절)
RegimeFn = Callable[[str, str], bool]  # (오늘, 전 거래일) → 이 날 새 진입을 허용하는지


@dataclass(frozen=True)
class Rule:
    """AI 분석가를 대신하는 시나리오 규칙."""
    name: str
    target_atr: float  # 목표가 = 진입가 + ATR × 이 값
    stop_atr: float  # 손절가 = 진입가 − ATR × 이 값
    probability: float = 0.45  # 목표가 도달 확률 가정 (리스크 엔진의 기대값 계산에만 쓴다)
    holding_days: int = 10
    trailing_atr: float | None = None  # 트레일링 손절 거리 (ATR 배수). None이면 고정 손절


@dataclass(frozen=True)
class Settings:
    market: str  # KR | US
    currency: str  # KRW | USD
    start: str  # YYYY-MM-DD (포함)
    end: str
    capital_krw: float = 10_000_000
    fx_rate: float = 1.0  # 통화 1단위의 원화 가치
    commission_rate: float = 0.00015
    candidates: int = 30  # 규칙 점수를 매길 종목 수 (전략 기본값)
    analyze_top: int = 3  # 시나리오를 만들 종목 수 (전략 기본값)
    max_total_krw: float | None = None  # 총 금액 한도. None이면 자본금만큼
    entry_mode: str = "limit"  # limit | open | limit_below
    entry_offset_atr: float = 0.5  # limit_below일 때 전일 종가에서 내리는 폭 (ATR 배수)
    fill_window_days: int = 1  # 지정가 주문이 살아 있는 거래일 수
    max_positions: int | None = None  # 동시 보유(진행 중) 종목 수 상한
    risk_limits: RiskLimits | None = None  # SWING 한도 재정의


@dataclass
class Trade:
    day: str  # 선별·주문일
    symbol: str
    name: str
    score: float
    entry: float
    target: float
    stop_trigger: float
    stop_order: float
    expire_date: str
    probability: float
    reward_risk: float
    approved: bool
    reasons: list[str]
    atr: float = 0.0
    limited_by: str = ""
    quantity: int = 0
    status: str = ""
    filled_at: str | None = None
    fill_price: float | None = None
    closed_at: str | None = None
    exit_price: float | None = None
    pnl: float | None = None  # 비용 차감 (거래 통화)
    ret: float | None = None  # 1주 기준 수익률 (비용 차감). 승인 여부와 무관하게 계산해 필터를 평가한다
    placed: bool = False  # 실제로 주문했는지 (승인 + 같은 종목 진행 중 아님)


@dataclass
class Result:
    settings: Settings
    rule: Rule
    trades: list[Trade] = field(default_factory=list)
    equity: list[tuple[str, float, float]] = field(default_factory=list)  # (날짜, 평가금액 원화, 투자 비중)
    funnel: dict = field(default_factory=dict)


def _f(c: dict, key: str) -> float:
    return float(c[key])


def plan_prices(entry: float, target: float, stop: float, currency: str) -> tuple[float, float, float, float]:
    """executor.make_plan과 같은 호가 맞춤 (모두 내림)."""
    stop_trigger = float(round_price(stop, currency))
    return (float(round_price(entry, currency)), float(round_price(target, currency)), stop_trigger,
            float(round_price(stop_trigger * (1 - STOP_LIMIT_BUFFER), currency)))


def expire_date(day: str, holding_days: int) -> str:
    return f"{date.fromisoformat(day) + timedelta(days=holding_days * 7 // 5 + 2)}"


def default_scenario(bars: list[dict], rule: Rule, atr: float) -> tuple[float, float, float]:
    """진입 = 전일 종가, 목표·손절 = ATR 배수."""
    last = _f(bars[-1], "closePrice")
    return last, last + atr * rule.target_atr, last - atr * rule.stop_atr


def simulate_trade(bars: list[dict], entry: float, target: float, stop_trigger: float,
                   stop_order: float, expire: str, entry_mode: str = "limit", fill_window: int = 1,
                   trail: float | None = None, currency: str = "KRW",
                   ) -> tuple[str, str | None, float | None, str | None, float | None]:
    """bars는 주문일부터의 일봉 (주문일 봉이 첫 번째, 없으면 체결 안 됨).

    entry_mode "open"이면 첫 봉 시가에 체결된다 (시장가). "limit"은 fill_window 거래일 안에 저가가 진입가
    이하로 오면 체결 (시가가 낮으면 시가). trail은 트레일링 손절 거리 (가격). 전날까지의 최고가 − trail이
    손절 감시가보다 높으면 감시가를 올린다 (주문가는 감시가 −1%).
    반환: (상태, 체결일, 체결가, 청산일, 청산가). 기간 안에 끝나지 않으면 OPEN.
    """
    if not bars:
        return UNFILLED, None, None, None, None
    filled_at = fill = None
    at_open = False
    highest = 0.0
    for i, c in enumerate(bars):
        o, h, l = _f(c, "openPrice"), _f(c, "highPrice"), _f(c, "lowPrice")  # noqa: E741 (시가·고가·저가)
        if fill is None:
            if entry_mode == "open":
                at_open = True
            else:
                if i >= fill_window:
                    return UNFILLED, None, None, None, None
                if l > entry:
                    continue
                at_open = o <= entry
            filled_at, fill = c["date"], (o if at_open else entry)
            first_day = True
        else:
            first_day = False
        if trail is not None and highest - trail > stop_trigger:
            stop_trigger = float(round_price(highest - trail, currency))
            stop_order = float(round_price(stop_trigger * (1 - STOP_LIMIT_BUFFER), currency))
        if not first_day:
            if c["date"] > expire:  # 기한이 지난 뒤 첫 거래일 시가에 시장가 매도
                return EXPIRED, filled_at, fill, c["date"], o
            if o <= stop_trigger:
                return STOP, filled_at, fill, c["date"], o
            if o >= target:
                return TARGET, filled_at, fill, c["date"], o
        if l <= stop_trigger:
            return STOP, filled_at, fill, c["date"], stop_order
        if (not first_day or at_open) and h >= target:
            return TARGET, filled_at, fill, c["date"], target
        highest = max(highest, h)
    if fill is None:
        return UNFILLED, None, None, None, None
    return OPEN, filled_at, fill, None, None


def net_return(fill: float, exit_: float, commission: float, tax: float) -> float:
    return (exit_ * (1 - commission - tax) - fill * (1 + commission)) / fill


class Backtest:
    def __init__(self, settings: Settings, rule: Rule, candles: dict[str, list[dict]], names: dict[str, str],
                 screen_fn: ScreenFn = screen.score, scenario_fn: ScenarioFn = default_scenario,
                 regime_fn: RegimeFn | None = None):
        """candles: 종목별 완성된 일봉 (과거 → 최신, 토스 형식 + "date")."""
        self.s, self.rule, self.candles, self.names = settings, rule, candles, names
        self.screen_fn, self.scenario_fn, self.regime_fn = screen_fn, scenario_fn, regime_fn
        self.days = sorted({c["date"] for bars in candles.values() for c in bars})  # 거래일
        self.calendar = [d for d in self.days if settings.start <= d <= settings.end]
        self.index = {sym: {c["date"]: i for i, c in enumerate(bars)} for sym, bars in candles.items()}
        self.tax = SELL_TAX_RATE[settings.market]

    def _before(self, symbol: str, day: str) -> list[dict]:
        """day 전까지의 일봉."""
        bars = self.candles[symbol]
        lo, hi = 0, len(bars)
        while lo < hi:
            mid = (lo + hi) // 2
            if bars[mid]["date"] < day:
                lo = mid + 1
            else:
                hi = mid
        return bars[:lo]

    def _from(self, symbol: str, day: str) -> list[dict]:
        i = self.index[symbol].get(day)
        return [] if i is None else self.candles[symbol][i:]

    def _last_close(self, symbol: str, day: str) -> float:
        i = self.index[symbol].get(day)
        if i is not None:
            return _f(self.candles[symbol][i], "closePrice")
        return _f(self._before(symbol, day)[-1], "closePrice")

    def scan(self, day: str, prev_day: str) -> list[screen.Pick]:
        """정규장 전 선별. 전일 거래대금 상위 → 규칙 점수."""
        ranked = []
        for sym, idx in self.index.items():
            i = idx.get(prev_day)
            if i is not None:
                c = self.candles[sym][i]
                ranked.append((_f(c, "closePrice") * _f(c, "volume"), sym))
        ranked.sort(reverse=True)
        picks = []
        for amount, sym in ranked[:RANK_COUNT][:self.s.candidates]:
            result = self.screen_fn(sym, self.names.get(sym, sym), self._before(sym, day)[-SCREEN_CANDLES:],
                                    amount)
            if isinstance(result, screen.Pick):
                picks.append(result)
        picks.sort(key=lambda p: p.score, reverse=True)
        return picks

    def run(self) -> Result:
        if self.s.risk_limits is None:
            return self._run()
        saved = risk.LIMITS["SWING"]
        risk.LIMITS["SWING"] = self.s.risk_limits  # assess는 모듈 전역 한도를 본다
        try:
            return self._run()
        finally:
            risk.LIMITS["SWING"] = saved

    def _run(self) -> Result:
        s, rule = self.s, self.rule
        res = Result(s, rule)
        funnel = res.funnel = {"days": 0, "regimeSkipped": 0, "picks": 0, "scenarios": 0, "factRejected": 0,
                               "riskRejected": 0, "approved": 0, "skippedActive": 0, "skippedMaxPositions": 0,
                               "placed": 0, "filled": 0, "rejectReasons": {}, "limitedBy": {}}
        cash = s.capital_krw / s.fx_rate
        active: list[Trade] = []  # 주문했고 아직 끝나지 않은 거래
        for day in self.calendar:
            prev_day = self._prev_trading_day(day)
            if prev_day is None:
                continue
            funnel["days"] += 1
            # 1. 정규장 전: 선별과 시나리오, 리스크 엔진
            reserved = 0.0
            if self.regime_fn is not None and not self.regime_fn(day, prev_day):
                funnel["regimeSkipped"] += 1
                picks = []
            else:
                picks = self.scan(day, prev_day)[:s.analyze_top]
            funnel["picks"] += len(picks)
            for p in picks:
                t = self._scenario(p, day)
                if t is None:
                    funnel["factRejected"] += 1
                    continue
                funnel["scenarios"] += 1
                # 오늘 낸 주문은 아직 체결 전이다 (미리 계산한 체결 결과를 쓰지 않는다)
                held_value = sum(a.quantity * self._last_close(a.symbol, prev_day) for a in active
                                 if a.day < day and a.fill_price is not None)
                invested = sum(a.quantity * (a.fill_price if a.day < day and a.fill_price else a.entry)
                               * (1 + s.commission_rate) for a in active)
                account = AccountContext(
                    equity_krw=(cash + held_value) * s.fx_rate,
                    buying_power=cash - reserved, commission_rate=s.commission_rate, fx_rate=s.fx_rate,
                    avg_daily_trading_amount=self._liquidity(p.symbol, day),
                    invested_krw=invested * s.fx_rate,
                    max_total_krw=s.max_total_krw if s.max_total_krw is not None else s.capital_krw)
                scenario = Scenario(symbol=p.symbol, currency=s.currency, horizon="SWING", entry_price=t.entry,
                                    target_price=t.target, stop_price=t.stop_trigger,
                                    probability=rule.probability, holding_days=rule.holding_days)
                a = assess(scenario, account)
                t.reward_risk, t.approved, t.reasons, t.limited_by = a.reward_risk, a.approved, a.reasons, a.limited_by
                t.quantity = int(a.quantity)
                res.trades.append(t)
                if not a.approved:
                    funnel["riskRejected"] += 1
                    for r in a.reasons:
                        key = r.split(" ")[0] if r.startswith("손익비") else r.split("(")[0].strip()
                        funnel["rejectReasons"][key] = funnel["rejectReasons"].get(key, 0) + 1
                    continue
                funnel["approved"] += 1
                funnel["limitedBy"][a.limited_by] = funnel["limitedBy"].get(a.limited_by, 0) + 1
                if any(x.symbol == t.symbol for x in active):
                    funnel["skippedActive"] += 1
                    continue
                if s.max_positions is not None and len(active) >= s.max_positions:
                    funnel["skippedMaxPositions"] += 1
                    continue
                t.placed = True
                funnel["placed"] += 1
                reserved += t.quantity * t.entry * (1 + s.commission_rate)
                active.append(t)
            # 2. 장중: 체결과 청산 (결과는 주문 때 미리 계산해 두고, 그 날이 되면 반영한다)
            for t in list(active):
                if t.status == UNFILLED and (t.fill_price is None and
                                             self._days_since(t.day, day) >= s.fill_window_days - 1):
                    active.remove(t)  # 주문 유효 기간 안에 체결되지 않았다
                    continue
                if t.filled_at == day:
                    funnel["filled"] += 1
                    cash -= t.quantity * t.fill_price * (1 + s.commission_rate)
                if t.closed_at == day:
                    t.pnl = t.quantity * t.fill_price * net_return(t.fill_price, t.exit_price,
                                                                   s.commission_rate, self.tax)
                    cash += t.quantity * t.exit_price * (1 - s.commission_rate - self.tax)
                    active.remove(t)
            # 3. 장 마감 평가
            held = sum(t.quantity * self._last_close(t.symbol, day) for t in active
                       if t.fill_price is not None and t.filled_at <= day)
            equity = cash + held
            res.equity.append((day, equity * s.fx_rate, held / equity if equity else 0.0))
        for t in active:  # 기간 끝까지 보유 중: 마지막 종가로 평가
            if t.fill_price is not None:
                t.pnl = t.quantity * t.fill_price * net_return(
                    t.fill_price, self._last_close(t.symbol, self.calendar[-1]), s.commission_rate, self.tax)
        return res

    def _prev_trading_day(self, day: str) -> str | None:
        i = self.days.index(day)
        return self.days[i - 1] if i > 0 else None

    def _days_since(self, start: str, day: str) -> int:
        return self.days.index(day) - self.days.index(start)

    def _liquidity(self, symbol: str, day: str) -> float:
        recent = self._before(symbol, day)[-LIQUIDITY_DAYS:]
        return sum(_f(c, "closePrice") * _f(c, "volume") for c in recent) / len(recent)

    def _scenario(self, p: screen.Pick, day: str) -> Trade | None:
        """규칙 시나리오를 만들고 체결·청산 결과를 미리 계산한다. 사실 검증에 걸리면 None."""
        bars = self._before(p.symbol, day)
        closes = [_f(c, "closePrice") for c in bars]
        atr = indicators.atr([_f(c, "highPrice") for c in bars], [_f(c, "lowPrice") for c in bars], closes)
        last = closes[-1]
        rule, s = self.rule, self.s
        prices = self.scenario_fn(bars, rule, atr)
        if prices is None:
            return None
        entry_raw, target_raw, stop_raw = prices
        if s.entry_mode == "limit_below":
            entry_raw = entry_raw - atr * s.entry_offset_atr
        raw = {"horizon": "SWING", "holdingDays": rule.holding_days, "entryPrice": entry_raw}
        if fact_check({"lastPrice": last}, raw):
            return None
        entry, target, stop_trigger, stop_order = plan_prices(entry_raw, target_raw, stop_raw, s.currency)
        if not 0 < stop_trigger < entry < target:
            return None
        expire = expire_date(day, rule.holding_days)
        status, filled_at, fill, closed_at, exit_ = simulate_trade(
            self._from(p.symbol, day), entry, target, stop_trigger, stop_order, expire,
            entry_mode=s.entry_mode, fill_window=s.fill_window_days,
            trail=None if rule.trailing_atr is None else atr * rule.trailing_atr, currency=s.currency)
        t = Trade(day=day, symbol=p.symbol, name=p.name, score=p.score, entry=entry, target=target,
                  stop_trigger=stop_trigger, stop_order=stop_order, expire_date=expire,
                  probability=rule.probability, reward_risk=0.0, approved=False, reasons=[], atr=atr,
                  status=status, filled_at=filled_at, fill_price=fill, closed_at=closed_at, exit_price=exit_)
        if fill is not None:
            last_price = exit_ if exit_ is not None else _f(self.candles[p.symbol][-1], "closePrice")
            t.ret = net_return(fill, last_price, s.commission_rate, self.tax)
        return t
