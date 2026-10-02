"""리스크 엔진. AI 판단과 무관하게 결정론적으로 수량과 통과 여부를 정한다.

금액은 시나리오 통화 기준으로 계산하고, 자산 대비 한도는 환율로 환산해 비교한다.
"""
import math
from dataclasses import dataclass, field

from .scenario import Scenario

# 매도 시 거래세율 가정. 실제 세율 확인 필요 (docs/DESIGN.md 참고).
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


# 종목당 비중 한도는 두지 않는다. 대신 자동 관리하는 포지션 전체에 총 금액 한도를 건다
# (AccountContext.max_total_krw, .env의 MAX_TOTAL_INVEST_KRW). 한 종목의 크기는 건당 위험 한도가 정한다.
LIMITS = {
    "SWING": RiskLimits(risk_per_trade=0.01, max_position=None, min_reward_risk=2.0,
                        max_daily_loss=0.03),
    "LONG_TERM": RiskLimits(risk_per_trade=0.02, max_position=None, min_reward_risk=2.5,
                            max_daily_loss=0.03),
}
MIN_FRACTIONAL_AMOUNT = 1.0  # 소수점(금액) 매수의 최소 금액 (달러)


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
    limited_by: str  # 수량을 결정한 제약
    fractional: bool = False  # 소수점 방식 (금액 ÷ 진입가만큼 소수점 수량으로 모의 매수)


def assess(scenario: Scenario, account: AccountContext, fractional: bool = False) -> RiskAssessment:
    """fractional이면 1주를 못 살 때 소수점 방식으로 계산한다 (미국 종목).

    정수 주로 1주 이상 살 수 있으면 정수 주를 쓴다.
    못 사면 금액으로 산다: 수량을 정수로 내리지 않고 금액을 센트 단위로 내린다 (모의 체결은 소수점 수량을 그대로 받는다).
    """
    # 손익비 기준은 AI에 알려주지 않는다. 기준에 맞춰 목표가를 부풀리는 것을 막기 위해서다.
    limits = LIMITS[scenario.horizon]
    s = scenario
    reasons = []

    buy_cost = account.commission_rate
    sell_cost = account.commission_rate + SELL_TAX_RATE[s.market_country]
    # 1주당 손익 (비용 반영)
    gain = s.target_price * (1 - sell_cost) - s.entry_price * (1 + buy_cost)
    loss = s.entry_price * (1 + buy_cost) - s.stop_price * (1 - STOP_LIMIT_BUFFER) * (1 - sell_cost)
    reward_risk = gain / loss
    ev_per_share = s.probability * gain - (1 - s.probability) * loss

    if reward_risk < limits.min_reward_risk:
        reasons.append(f"손익비 {reward_risk:.2f}가 최소 기준 {limits.min_reward_risk:.1f}보다 낮음")
    if ev_per_share <= 0:
        reasons.append("비용을 반영한 기대값이 0 이하")
    if account.warnings:
        reasons.append(f"매수 유의 종목: {', '.join(account.warnings)}")
    if account.daily_loss_krw >= account.equity_krw * limits.max_daily_loss:
        reasons.append("일일 손실 한도 도달")
    if limits.max_daily_trades is not None and account.daily_trades >= limits.max_daily_trades:
        reasons.append(f"일일 매매 건수 한도({limits.max_daily_trades}건) 도달")

    equity = account.equity_krw / account.fx_rate  # 시나리오 통화로 환산
    unit_cost = s.entry_price * (1 + buy_cost)
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
            reasons.append(f"매수 금액이 최소 주문 금액 {MIN_FRACTIONAL_AMOUNT:g}보다 적음 ({limited_by})")
    else:
        quantity = max(math.floor(caps[limited_by]), 0)
        amount = quantity * s.entry_price
        if quantity < 1:
            reasons.append(f"매수 가능 수량이 1주 미만 ({limited_by})")

    return RiskAssessment(
        approved=not reasons,
        reasons=reasons,
        quantity=quantity,
        amount=amount,
        reward_risk=reward_risk,
        expected_profit=quantity * gain,
        max_loss=quantity * loss,
        expected_value=quantity * ev_per_share,
        expected_return=ev_per_share / s.entry_price,
        limited_by=limited_by,
        fractional=fractional,
    )
