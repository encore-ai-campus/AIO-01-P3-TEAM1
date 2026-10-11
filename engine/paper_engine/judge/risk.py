"""리스크 엔진. AI 판단과 무관하게 결정론적으로 수량과 통과 여부를 정한다.

금액은 시나리오 통화 기준으로 계산하고, 자산 대비 한도는 환율로 환산해 비교한다.
탈락 사유(reasons)마다 같은 자리에 사유 코드(codes)를 둔다 — 화면이 코드로 쉬운 문장을 고른다
(docs/API.md "실행 불가 사유 코드"). 새 사유를 더하면 그 표를 먼저 고친다.
사유 문장의 숫자 뒤 조사(이/가)는 josa가 숫자를 읽는 소리로 고른다 ("손익비 0.73이", "손익비 1.5가").

수량을 정하는 방식은 둘이다.
- assess: 제약(건당 위험·매수 가능 금액·총 금액·유동성 한도) 중 가장 작은 값으로 수량을 정한다 (엔진 CLI·엔진 자체 계좌).
- assess_budget: 사용자가 정한 금액을 1주 매수 비용으로 나눠 수량을 정하고, 한도는 줄이지 않고 점검만 한다 (계획 활성화 —
  docs/API.md "넣을 돈", docs/DECISIONS.md 28장, 2026-10-11). 건당 위험 한도는 수량을 정하지도 줄이지도 않는다.
크기와 무관한 점검(손익비·기대값·매수 유의·일일 손실·일일 건수)은 둘이 같다 (_screen).
"""
import math
import re
from dataclasses import dataclass, field

from .scenario import Scenario

# 매도 시 거래세율 가정. 실제 세율 확인 필요 (docs/design/DESIGN.md 참고).
SELL_TAX_RATE = {"KR": 0.002, "US": 0.0}
# 손절 주문가는 감시가보다 이만큼 낮게 본다 (executor의 주문 계획과 예상 손익에 쓴다).
# 손실은 이 주문가 기준으로 계산해서 손익비와 수량이 최악의 손절 체결을 반영하게 한다.
STOP_LIMIT_BUFFER = 0.01


@dataclass(frozen=True)
class RiskLimits:
    risk_per_trade: float  # 1회 매매에서 잃어도 되는 금액 (자산 대비)
    max_position: float | None  # 종목당 최대 비중 (자산 대비). None이면 두지 않는다
    min_reward_risk: float  # 최소 손익비
    max_daily_loss: float  # 일일 손실 한도 (자산 대비)
    max_liquidity_share: float = 0.01  # 일평균 거래대금 대비 최대 주문 비율
    max_daily_trades: int | None = None


# 스윙은 종목당 비중 한도를 두지 않는다. 대신 자동 관리하는 포지션 전체에 총 금액 한도를 건다
# (AccountContext.max_total_krw, .env의 MAX_TOTAL_INVEST_KRW). assess에서 한 종목의 크기는 건당 위험 한도가 정한다
# (assess_budget에서는 사용자가 정한 금액이 정한다 — risk_per_trade는 화면의 큰 손실 경고 기준으로만 쓴다, docs/API.md largeLoss).
# LONG_TERM의 비중 한도 100%는 손절 없는 장기 보유 매수 점검(assess_position)에 쓴다 (docs/DECISIONS.md 14-3, E-4).
# 스윙 최소 손익비는 2.0이었다가 1.5로 낮췄다 (2026-10-07, 손절가를 코드가 정하게 바꾸면서 — docs/design/DESIGN.md "리스크 엔진").
LIMITS = {
    "SWING": RiskLimits(risk_per_trade=0.01, max_position=None, min_reward_risk=1.5,
                        max_daily_loss=0.03),
    "LONG_TERM": RiskLimits(risk_per_trade=0.02, max_position=1.0, min_reward_risk=2.5,
                            max_daily_loss=0.03),
}
MIN_FRACTIONAL_AMOUNT = 1.0  # 소수점(금액) 매수의 최소 금액 (달러)
BUDGET_LIMITED = "내가 정한 금액"  # assess_budget의 limited_by (docs/API.md RiskPreview.limitedBy)

# 숫자 한 자리를 읽는 소리(영 일 이 삼 사 오 육 칠 팔 구)에 받침이 있는지
_DIGIT_FINAL = dict(zip("0123456789", (True, True, False, True, False, False, True, True, True, False)))
_NUMBER_END = re.compile(r"(\d[\d,]*)(\.\d+)?$")


def _has_final(word: str) -> bool | None:
    """word를 읽을 때 마지막 소리에 받침이 있는지. 한글 음절·숫자가 아니면 None.

    숫자는 읽는 소리로 본다: 소수는 마지막 자리(0.73 → 삼), 정수는 끝의 0을 자릿수 이름(십·백·천·만·억은 받침, 조는 없음)으로.
    """
    word = word.rstrip()
    if not word:
        return None
    last = word[-1]
    if "가" <= last <= "힣":
        return (ord(last) - ord("가")) % 28 != 0
    number = _NUMBER_END.search(word)
    if number is None:
        return None
    integer, decimals = number.group(1).replace(",", ""), number.group(2)
    if decimals:
        return _DIGIT_FINAL[decimals[-1]]
    zeros = len(integer) - len(integer.rstrip("0"))
    if zeros == 0 or zeros == len(integer):  # 끝이 0이 아니거나 0 하나(영)
        return _DIGIT_FINAL[integer[-1]]
    return not 12 <= zeros < 16  # 십·백·천·만·억(받침) · 조(받침 없음) · 경(받침)


def josa(word: str, final: str = "이", plain: str = "가") -> str:
    """word 바로 뒤에 붙일 조사. 마지막 소리에 받침이 있으면 final(이·은·을), 없으면 plain(가·는·를).

    josa("0.73") == "이", josa("1.5") == "가", josa("1,000") == "이", josa("삼성전자", "은", "는") == "는".
    한글·숫자로 끝나지 않으면 둘 다 ("이(가)").
    """
    has = _has_final(word)
    return f"{final}({plain})" if has is None else (final if has else plain)


@dataclass(frozen=True)
class AccountContext:
    equity_krw: float  # 총 자산 (원화 환산)
    buying_power: float  # 시나리오 통화 기준 매수 가능 금액
    commission_rate: float
    fx_rate: float = 1.0  # 시나리오 통화 1단위의 원화 가치 (KRW면 1)
    position_value: float = 0.0  # 해당 종목 기존 보유 평가액 (시나리오 통화)
    daily_loss_krw: float = 0.0  # 오늘 확정 손실 (양수)
    daily_trades: int = 0
    avg_daily_trading_amount: float | None = None  # 시나리오 통화
    warnings: list[str] = field(default_factory=list)
    invested_krw: float = 0.0  # 자동 관리 중인 포지션과 진입 대기 주문의 매수 금액 합계 (원화 환산)
    max_total_krw: float | None = None  # 총 금액 한도 (원화). None이면 두지 않는다


@dataclass(frozen=True)
class RiskAssessment:
    approved: bool
    reasons: list[str]  # 탈락 사유. 통과하면 비어 있다.
    quantity: float  # 정수 주. 소수점 방식이면 금액 ÷ 진입가로 계산한 예상 수량
    amount: float  # 매수 금액
    reward_risk: float
    expected_profit: float  # 목표가 도달 시 수익 (비용 차감)
    max_loss: float  # 손절 시 손실 (비용 포함, 양수)
    expected_value: float
    expected_return: float  # 기대값 / 매수 금액
    limited_by: str  # 수량을 결정한 제약 (assess_budget은 BUDGET_LIMITED, 금액이 없으면 "")
    fractional: bool = False  # 소수점 방식 (금액 ÷ 진입가만큼 소수점 수량으로 모의 매수)
    codes: list[str] = field(default_factory=list)  # reasons[i]의 사유 코드 (같은 길이·같은 순서)


def _screen(s: Scenario, account: AccountContext,
            limits: RiskLimits) -> tuple[float, float, float, list[str], list[str]]:
    """크기와 무관한 점검 (assess와 assess_budget이 같이 쓴다). 반환: (1주 이익, 1주 손실, 1주 기대값, 사유, 사유 코드).

    1주 손익은 비용(수수료·매도 거래세)과 손절 주문가(STOP_LIMIT_BUFFER)를 반영한다.
    사유 순서: reward_risk_low · ev_negative · warning_stock · daily_loss_limit · daily_trades_limit.
    """
    # 손익비 기준은 AI에 알려주지 않는다. 기준에 맞춰 목표가를 부풀리는 것을 막기 위해서다.
    reasons, codes = [], []

    def reject(code: str, reason: str) -> None:
        codes.append(code)
        reasons.append(reason)

    buy_cost = account.commission_rate
    sell_cost = account.commission_rate + SELL_TAX_RATE[s.market_country]
    # 1주당 손익 (비용 반영)
    gain = s.target_price * (1 - sell_cost) - s.entry_price * (1 + buy_cost)
    loss = s.entry_price * (1 + buy_cost) - s.stop_price * (1 - STOP_LIMIT_BUFFER) * (1 - sell_cost)
    reward_risk = gain / loss
    ev_per_share = s.probability * gain - (1 - s.probability) * loss

    if reward_risk < limits.min_reward_risk:
        shown = f"{reward_risk:.2f}"
        reject("reward_risk_low", f"손익비 {shown}{josa(shown)} 최소 기준 {limits.min_reward_risk:.1f}보다 낮음")
    if ev_per_share <= 0:
        reject("ev_negative", "비용을 반영한 기대값이 0 이하")
    if account.warnings:
        reject("warning_stock", f"매수 유의 종목: {', '.join(account.warnings)}")
    if account.daily_loss_krw >= account.equity_krw * limits.max_daily_loss:
        reject("daily_loss_limit", "일일 손실 한도 도달")
    if limits.max_daily_trades is not None and account.daily_trades >= limits.max_daily_trades:
        reject("daily_trades_limit", f"일일 매매 건수 한도({limits.max_daily_trades}건) 도달")
    return gain, loss, ev_per_share, reasons, codes


def _result(s: Scenario, gain: float, loss: float, ev_per_share: float, quantity: float, amount: float,
            reasons: list[str], codes: list[str], limited_by: str, fractional: bool) -> RiskAssessment:
    return RiskAssessment(
        approved=not reasons,
        reasons=reasons,
        quantity=quantity,
        amount=amount,
        reward_risk=gain / loss,
        expected_profit=quantity * gain,
        max_loss=quantity * loss,
        expected_value=quantity * ev_per_share,
        expected_return=ev_per_share / s.entry_price,
        limited_by=limited_by,
        fractional=fractional,
        codes=codes,
    )


def assess(scenario: Scenario, account: AccountContext, fractional: bool = False) -> RiskAssessment:
    """fractional이면 1주를 못 살 때 소수점 방식으로 계산한다 (미국 종목).

    정수 주로 1주 이상 살 수 있으면 정수 주를 쓴다.
    못 사면 금액으로 산다: 수량을 정수로 내리지 않고 금액을 센트 단위로 내린다 (모의 체결은 소수점 수량을 그대로 받는다).
    """
    limits = LIMITS[scenario.horizon]
    s = scenario
    gain, loss, ev_per_share, reasons, codes = _screen(s, account, limits)

    def reject(code: str, reason: str) -> None:
        codes.append(code)
        reasons.append(reason)

    equity = account.equity_krw / account.fx_rate  # 시나리오 통화로 환산
    unit_cost = s.entry_price * (1 + account.commission_rate)
    caps = {
        "건당 위험 한도": equity * limits.risk_per_trade / loss,
        "매수 가능 금액": account.buying_power / unit_cost,
    }
    if limits.max_position is not None:
        caps["종목당 비중 한도"] = (equity * limits.max_position - account.position_value) / unit_cost
    if account.max_total_krw is not None:
        room = (account.max_total_krw - account.invested_krw) / account.fx_rate
        caps["총 금액 한도"] = room / unit_cost
    if account.avg_daily_trading_amount is not None:
        caps["유동성 한도"] = account.avg_daily_trading_amount * limits.max_liquidity_share / unit_cost
    limited_by = min(caps, key=caps.get)
    fractional = fractional and caps[limited_by] < 1
    if fractional:
        amount = max(math.floor(caps[limited_by] * s.entry_price * 100) / 100, 0.0)
        quantity = amount / s.entry_price
        if amount < MIN_FRACTIONAL_AMOUNT:
            reject("size_too_small", f"매수 금액이 최소 주문 금액 {MIN_FRACTIONAL_AMOUNT:g}보다 적음 ({limited_by})")
    else:
        quantity = max(math.floor(caps[limited_by]), 0)
        amount = quantity * s.entry_price
        if quantity < 1:
            reject("size_too_small", f"매수 가능 수량이 1주 미만 ({limited_by})")
    return _result(s, gain, loss, ev_per_share, quantity, amount, reasons, codes, limited_by, fractional)


def assess_budget(scenario: Scenario, account: AccountContext, budget: float | None,
                  fractional: bool = False) -> RiskAssessment:
    """사용자가 정한 금액(budget, 시나리오 통화)으로 수량을 계산하고 한도는 점검만 한다 (docs/API.md "넣을 돈").

    크기와 무관한 점검은 assess와 같다 (_screen — 문장·순서도 같다). 건당 위험 한도로 수량을 정하거나 줄이지 않는다.
    수량: 국내(fractional 아님)는 floor(금액 ÷ (진입가 × (1 + 수수료))) 정수 주.
      fractional(미국)이면 매수 금액 = floor(금액 ÷ (1 + 수수료) × 100) / 100 (센트 내림), 수량 = 매수 금액 ÷ 진입가 (소수점 수량).
    amount는 수수료를 뺀 매수 금액이다 (assess와 같다). 크기 점검은 줄이지 않고 막는다 (사유는 _screen 사유 뒤에 이 순서로):
      budget_too_small  국내는 1주 미만, 미국은 매수 금액이 MIN_FRACTIONAL_AMOUNT 미만
      cash_short · position_limit · total_limit   매수 금액(수수료 포함)으로 본 assess_position과 같은 점검·문장 (살 수량이 있을 때만)
    budget이 None이면 크기 계산·크기 점검 없이 앞의 점검만 한다 (quantity·amount 0, limited_by "").
    """
    limits = LIMITS[scenario.horizon]
    s = scenario
    gain, loss, ev_per_share, reasons, codes = _screen(s, account, limits)
    if budget is None:
        return _result(s, gain, loss, ev_per_share, 0, 0.0, reasons, codes, "", False)

    commission = account.commission_rate
    if fractional:
        amount = max(math.floor(budget / (1 + commission) * 100) / 100, 0.0)
        quantity = amount / s.entry_price
        if amount < MIN_FRACTIONAL_AMOUNT:
            codes.append("budget_too_small")
            reasons.append(f"내가 정한 금액으로 살 매수 금액(${_money(amount)})이 "
                           f"최소 주문 금액 ${MIN_FRACTIONAL_AMOUNT:g}보다 적음")
    else:
        quantity = max(math.floor(budget / (s.entry_price * (1 + commission))), 0)
        amount = quantity * s.entry_price
        if quantity < 1:
            codes.append("budget_too_small")
            reasons.append(f"내가 정한 금액({_in(budget, s.currency)})으로는 1주도 살 수 없음")
    if amount > 0:
        _, size_reasons, size_codes = _check_size(amount * (1 + commission), account, limits)
        reasons += size_reasons
        codes += size_codes
    return _result(s, gain, loss, ev_per_share, quantity, amount, reasons, codes, BUDGET_LIMITED, fractional)


def _money(value: float) -> str:
    """금액 표시: 천 단위 쉼표, 소수 둘째 자리까지 (".00"은 뗀다. 통화 기호 없음)."""
    return f"{value:,.2f}".removesuffix(".00")


def _in(value: float, currency: str) -> str:
    """통화를 붙인 금액 표시 (1,000원 · $12.5)."""
    return f"{_money(value)}원" if currency == "KRW" else f"${_money(value)}"


def _check_size(cost: float, account: AccountContext, limits: RiskLimits) -> tuple[bool, list[str], list[str]]:
    """매수 금액 cost(수수료 포함, 종목 통화)의 한도 점검 — 줄이지 않는다 (assess_position·assess_budget이 같이 쓴다).

    반환: (통과 여부, 사유, 사유 코드). 코드 순서: cash_short · position_limit · total_limit (assess_position 설명).
    """
    reasons, codes = [], []
    if cost > account.buying_power:
        codes.append("cash_short")
        shown = _money(cost)
        reasons.append(f"매수 금액 {shown}{josa(shown)} 매수 가능 금액 {_money(account.buying_power)}보다 큼")
    if limits.max_position is not None:
        equity = account.equity_krw / account.fx_rate  # 종목 통화로 환산
        if account.position_value + cost > equity * limits.max_position:
            codes.append("position_limit")
            reasons.append(f"종목당 비중 한도({limits.max_position:.0%})를 넘음")
    if account.max_total_krw is not None:
        room = account.max_total_krw - account.invested_krw
        if cost * account.fx_rate > room:
            codes.append("total_limit")
            reasons.append(f"총 금액 한도 {_money(account.max_total_krw)}원을 넘음 (남은 한도 {_money(max(room, 0))}원)")
    return not reasons, reasons, codes


def assess_position(price: float, quantity: float, account: AccountContext,
                    limits: RiskLimits) -> tuple[bool, list[str], list[str]]:
    """손절가가 없는 장기 보유 매수의 점검 (docs/API.md "보유 방식"). 수량은 사용자가 정하고, 이 점검은 줄이지 않는다.

    price는 종목 통화의 1주 가격 (지정가, 시장가면 직전 종가 — 장마감 기준), quantity는 매수 수량.
    매수 금액은 수수료를 포함한다. 반환: (통과 여부, 사유, 사유 코드) — 사유와 코드는 같은 길이·같은 순서다.
      cash_short      매수 금액이 매수 가능 금액(account.buying_power)보다 큼
      position_limit  기존 보유 평가액 + 매수 금액이 자산 × limits.max_position을 넘음 (max_position이 있을 때만)
      total_limit     자동 관리 투자 금액 + 매수 금액(원화)이 총 금액 한도(account.max_total_krw)를 넘음 (한도가 있을 때만)
    """
    if price <= 0 or quantity <= 0:
        raise ValueError(f"가격과 수량은 0보다 커야 합니다: {price}, {quantity}")
    return _check_size(price * quantity * (1 + account.commission_rate), account, limits)  # 종목 통화
