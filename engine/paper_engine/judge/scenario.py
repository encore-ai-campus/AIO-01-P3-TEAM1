"""AI가 제안하는 매매 시나리오의 고정 형식."""
from dataclasses import dataclass, field

# 형식. LONG_TERM은 이전 기록과 리스크 한도 때문에 남겨 둔다.
HORIZONS = ("SWING", "LONG_TERM")
# AI가 제안해 매매하는 것 (사실 검증에서 거른다)
TRADABLE_HORIZONS = ("SWING",)
SWING_MIN_DAYS, SWING_MAX_DAYS = 3, 20  # 스윙 보유 기간 (거래일, 양 끝 포함)


@dataclass(frozen=True)
class Scenario:
    symbol: str
    currency: str  # KRW | USD
    horizon: str  # SWING | LONG_TERM
    entry_price: float
    target_price: float
    stop_price: float
    probability: float  # 손절 전에 목표가에 도달할 확률 (0~1)
    holding_days: int
    analyst: str = ""
    rationale: list[str] = field(default_factory=list)
    invalidation: str = ""

    def __post_init__(self):
        if self.currency not in ("KRW", "USD"):
            raise ValueError(f"currency는 KRW 또는 USD여야 합니다: {self.currency}")
        if self.horizon not in HORIZONS:
            raise ValueError(f"horizon은 {HORIZONS} 중 하나여야 합니다: {self.horizon}")
        if not 0 <= self.probability <= 1:
            raise ValueError(f"probability는 0~1이어야 합니다: {self.probability}")
        if self.holding_days < 1:
            raise ValueError(f"holding_days는 1 이상이어야 합니다: {self.holding_days}")
        # 매수 시나리오만 다룬다 (공매도 없음).
        if not 0 < self.stop_price < self.entry_price < self.target_price:
            raise ValueError("가격은 0 < 손절가 < 진입가 < 목표가 순서여야 합니다: "
                             f"{self.stop_price}, {self.entry_price}, {self.target_price}")

    @property
    def market_country(self) -> str:
        return "KR" if self.currency == "KRW" else "US"

    @classmethod
    def from_dict(cls, data: dict) -> "Scenario":
        return cls(
            symbol=data["symbol"],
            currency=data["currency"],
            horizon=data["horizon"],
            entry_price=float(data["entryPrice"]),
            target_price=float(data["targetPrice"]),
            stop_price=float(data["stopPrice"]),
            probability=float(data["probability"]),
            holding_days=int(data["holdingDays"]),
            analyst=data.get("analyst", ""),
            rationale=list(data.get("rationale", [])),
            invalidation=data.get("invalidation", ""),
        )
