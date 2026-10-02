"""전략: 자동매매 규칙 묶음. 활성 전략만 매일 정규장 시작 1시간 전에 돈다 (scheduler.upcoming_scan).

한 전략이 정하는 것:
  - 시장 (KR | US)
  - 후보 수: 거래대금 상위에서 ETF 등을 뺀 뒤 규칙 점수를 매길 종목 수
  - 분석 수: 규칙 점수 상위 몇 개를 AI 교차검증할지 (종목당 약 $0.3)
  - 실행: notify(알림만) | paper(승인된 시나리오를 모의 계좌로 자동 매수. 요청자는 strategy:<번호>)
    원본의 confirm(컨펌 후 주문)은 읽을 때 paper로 바꾼다
  - 한도: 종목당 매수 금액 상한. 리스크 엔진의 매수 가능 금액을 이 값으로 줄인다
  - 소수점: 미국 전략에서 1주를 못 사는 종목을 소수점 수량으로 산다
  - 리포트 후보: 최근 증권사 리포트 헤드라인의 종목도 규칙 점수에 태운다 (data/broker_reports.py,
    거래대금 상위 후보·보유·자동 관리·최근 분석 종목은 뺀다. __main__.screen_market 참고)

저장은 Redis(paper:strategy:*)에 한다.
"""
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime

from .records.redis_client import Redis

KEY = "paper"
DEFAULTS = [
    {"name": "기본 국내 선별", "market": "KR"},
    {"name": "기본 미국 선별", "market": "US"},
]
ACTION_LABEL = {"notify": "알림만", "paper": "모의 자동 매수"}
LEGACY_ACTIONS = {"confirm": "paper"}
MARKET_LABEL = {"KR": "국내", "US": "미국"}


@dataclass
class Strategy:
    id: int
    name: str
    market: str
    action: str = "notify"
    candidates: int = 30
    analyze_top: int = 3
    max_amount: float | None = None
    max_currency: str | None = None  # KRW | USD
    fractional: bool = False  # 미국만. 1주를 못 살 때 금액 ÷ 진입가만큼 소수점 수량으로 산다
    reports: bool = False  # 증권사 리포트 헤드라인의 종목도 선별 후보에 넣는다
    status: str = "active"  # active | stopped
    created_at: str = field(default_factory=lambda: datetime.now().astimezone().isoformat())
    last_run_at: str | None = None
    last_summary: str | None = None

    def __post_init__(self):
        self.action = LEGACY_ACTIONS.get(self.action, self.action)
        if self.action not in ACTION_LABEL:
            raise ValueError(f"전략 실행 방식은 {', '.join(ACTION_LABEL)} 중 하나: {self.action}")

    @property
    def auto_buy(self) -> bool:
        return self.action == "paper"

    @property
    def active(self) -> bool:
        return self.status == "active"

    def limit_text(self) -> str:
        if self.max_amount is None:
            return "한도 없음 (리스크 엔진 기준)"
        if self.max_currency == "USD":
            return f"종목당 ${self.max_amount:,.2f}"
        return f"종목당 {self.max_amount:,.0f}원"

    def max_amount_krw(self, usd_krw: float) -> float | None:
        if self.max_amount is None:
            return None
        return self.max_amount * (usd_krw if self.max_currency == "USD" else 1)

    def summary(self) -> str:
        state = "활성" if self.active else "중지"
        return (f"#{self.id} {self.name} [{state}] {MARKET_LABEL[self.market]} · "
                f"{ACTION_LABEL[self.action]} · 후보 {self.candidates} · AI 분석 {self.analyze_top} · "
                f"{self.limit_text()}" + (" · 소수점 허용" if self.fractional else "")
                + (" · 리포트 후보" if self.reports else ""))


class StrategyBook:
    def __init__(self, redis: Redis):
        self.r = redis

    def ensure_defaults(self, markets: tuple[str, ...] = ("KR", "US")) -> list[Strategy]:
        """처음 한 번만 운영 시장(MARKETS)의 기본 전략을 만든다 (개장 전 종목 선별, 알림만)."""
        if not self.r.set(f"{KEY}:strategy:seeded", "1", nx=True):
            return []
        return [self.create(**d) for d in DEFAULTS if d["market"] in markets]

    def create(self, **fields) -> Strategy:
        sid = self.r.incr(f"{KEY}:strategy:seq")
        s = Strategy(id=sid, **fields)
        self.save(s)
        self.r.sadd(f"{KEY}:strategies", str(sid))
        return s

    def save(self, s: Strategy) -> None:
        self.r.set(f"{KEY}:strategy:{s.id}", json.dumps(asdict(s), ensure_ascii=False))

    def get(self, sid: int) -> Strategy | None:
        raw = self.r.get(f"{KEY}:strategy:{sid}")
        return Strategy(**json.loads(raw)) if raw else None

    def all(self) -> list[Strategy]:
        items = [self.get(int(i)) for i in self.r.smembers(f"{KEY}:strategies")]
        return sorted((s for s in items if s), key=lambda s: s.id)

    def set_status(self, sid: int, status: str) -> Strategy | None:
        s = self.get(sid)
        if s:
            s.status = status
            self.save(s)
        return s

    def record_run(self, sid: int, summary: str) -> None:
        s = self.get(sid)
        if s:
            s.last_run_at = datetime.now().astimezone().isoformat()
            s.last_summary = summary
            self.save(s)
