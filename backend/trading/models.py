"""팀원별 모의 계좌 (docs/DECISIONS.md 4-1, 8-1). 표 이름·열은 엔진 SQLite 표와 같다 (+ 계좌 user, 계좌 FK).

금액은 엔진이 float로 계산하므로 FloatField. PostgreSQL 전용 기능은 쓰지 않는다 (로컬 SQLite, 운영 PostgreSQL).
"""
from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone

ACTIVE_STATUSES = ("ENTRY_PENDING", "EXIT_WATCHING")
# 보유 방식 (docs/API.md "보유 방식", docs/DECISIONS.md 14-3): swing 목표·손절(·기한)로 자동 매도 · long 자동 매도 없음.
# 주문할 때 정해지고 바뀌지 않는다
SWING, LONG = "swing", "long"
STYLES = (SWING, LONG)


class PaperAccount(models.Model):
    """팀원 한 명의 모의 계좌. 처음 쓸 때 PAPER_CAPITAL_KRW로 만든다 (store.account_for)."""
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="paper_account")
    name = models.CharField(max_length=150)
    initial_capital_krw = models.FloatField()
    cash_krw = models.FloatField()  # 원화만. 달러 종목은 체결 시점 환율로 환산해 넣고 뺀다
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "paper_account"

    def __str__(self) -> str:
        return self.name


class PaperOrder(models.Model):
    """매수 주문 하나 = 포지션 하나 (매수 → 보유·감시 → 전량 청산)."""
    account = models.ForeignKey(PaperAccount, on_delete=models.CASCADE, related_name="orders")
    requested_by = models.CharField(max_length=150)  # 팀원 아이디, strategy:<번호>, cli
    trade_id = models.IntegerField(null=True, blank=True)  # AI 시나리오에서 나온 주문이면 연결
    symbol = models.CharField(max_length=20)
    name = models.CharField(max_length=200)
    market = models.CharField(max_length=2)  # KR | US
    currency = models.CharField(max_length=3)  # KRW | USD
    order_type = models.CharField(max_length=6)  # MARKET | LIMIT
    limit_price = models.FloatField(null=True, blank=True)
    quantity = models.FloatField()
    entry_price = models.FloatField()  # 계획 진입가 (시장가는 주문 시점 확인 가격)
    target_price = models.FloatField(null=True, blank=True)
    stop_price = models.FloatField(null=True, blank=True)
    expire_date = models.DateField(null=True, blank=True)  # 보유 기한 (지나면 다음 정규장에서 청산)
    status = models.CharField(max_length=16, db_index=True)  # ENTRY_PENDING | EXIT_WATCHING | CLOSED | CANCELED
    filled_quantity = models.FloatField(null=True, blank=True)
    fill_price = models.FloatField(null=True, blank=True)
    fill_fx_rate = models.FloatField(null=True, blank=True)
    filled_at = models.DateTimeField(null=True, blank=True)
    exit_price = models.FloatField(null=True, blank=True)
    exit_fx_rate = models.FloatField(null=True, blank=True)
    exit_reason = models.CharField(max_length=8, null=True, blank=True)  # TARGET | STOP | EXPIRED | MANUAL
    closed_at = models.DateTimeField(null=True, blank=True)
    pnl = models.FloatField(null=True, blank=True)  # 실현 손익 (종목 통화). 수수료·세금 포함
    pnl_krw = models.FloatField(null=True, blank=True)
    signal_count = models.IntegerField(default=0)  # 청산 조건 연속 확인 횟수
    note = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField()
    style = models.CharField(max_length=5, default=SWING, db_default=SWING)  # db_default: 예전 코드가 공유 DB에 넣어도 되게. swing | long (위 STYLES)

    class Meta:
        db_table = "paper_orders"
        constraints = [
            # 같은 종목은 진행 중 포지션 하나만 (부분 유일 인덱스, SQLite·PostgreSQL 모두 지원)
            models.UniqueConstraint(fields=["account", "symbol"], condition=Q(status__in=ACTIVE_STATUSES),
                                    name="paper_orders_one_active_per_symbol"),
        ]

    def __str__(self) -> str:
        return f"#{self.id} {self.name} ({self.symbol}) {self.status}"


class PaperFill(models.Model):
    account = models.ForeignKey(PaperAccount, on_delete=models.CASCADE, related_name="fills")
    order = models.ForeignKey(PaperOrder, on_delete=models.CASCADE, related_name="fills")
    side = models.CharField(max_length=4)  # BUY | SELL
    price = models.FloatField()
    quantity = models.FloatField()
    amount = models.FloatField()  # price × quantity (종목 통화)
    commission = models.FloatField()
    tax = models.FloatField()
    fx_rate = models.FloatField()  # 종목 통화 1단위의 원화 가치 (KRW는 1)
    cash_change_krw = models.FloatField()  # 현금 증감 (매수 음수, 매도 양수)
    reason = models.CharField(max_length=8)  # ENTRY | TARGET | STOP | EXPIRED | MANUAL
    filled_at = models.DateTimeField()

    class Meta:
        db_table = "paper_fills"


class EquityDaily(models.Model):
    """일별 자산. 국내 정규장이 끝난 뒤 하루 한 번 (run_engine)."""
    account = models.ForeignKey(PaperAccount, on_delete=models.CASCADE, related_name="equity_days")
    day = models.DateField()  # KST
    cash_krw = models.FloatField()
    holdings_value_krw = models.FloatField()
    equity_krw = models.FloatField()
    recorded_at = models.DateTimeField()

    class Meta:
        db_table = "equity_daily"
        constraints = [models.UniqueConstraint(fields=["account", "day"], name="equity_daily_account_day")]


class Reservation(models.Model):
    """정규장 밖에서 받은 시장가 매수·전량 매도. run_engine이 예약 뒤 처음 시작하는 정규장에 실행한다 (8-3)."""
    account = models.ForeignKey(PaperAccount, on_delete=models.CASCADE, related_name="reservations")
    kind = models.CharField(max_length=4)  # BUY | SELL
    symbol = models.CharField(max_length=20)
    name = models.CharField(max_length=200)
    market = models.CharField(max_length=2)
    currency = models.CharField(max_length=3)
    quantity = models.FloatField()  # 매수 수량 (매도는 포지션 전량이라 기록용)
    order = models.ForeignKey(PaperOrder, on_delete=models.CASCADE, null=True, blank=True,
                              related_name="reservations")  # 매도할 포지션
    target_price = models.FloatField(null=True, blank=True)
    stop_price = models.FloatField(null=True, blank=True)
    days = models.IntegerField(null=True, blank=True)  # 보유 기한 (실행일부터 달력 일수)
    reference_price = models.FloatField(null=True, blank=True)  # 예약 때 가격. 실행 때 많이 벗어나면 매수하지 않는다
    created_at = models.DateTimeField(default=timezone.now)
    # BUY 예약의 보유 방식(swing | long) = 예약을 받을 때 정한 값. 실행할 때 이 값으로 주문한다 (다시 추론하지 않는다). SELL은 None
    style = models.CharField(max_length=5, null=True, blank=True)

    class Meta:
        db_table = "reservations"

    def __str__(self) -> str:
        return f"#{self.id} {self.kind} {self.name} ({self.symbol})"


class EngineStatus(models.Model):
    """엔진 루프의 생존 신호 (admin/API.md 5-1). run_engine이 30초마다 자기 행을 고치고, 관리 서버가 읽기 전용 계정으로 읽는다.

    웹 API는 이 표를 쓰지 않는다. 비밀 값은 넣지 않는다 (한도 숫자와 오류 이름·짧은 문장만).
    """
    name = models.CharField(max_length=32, unique=True)  # 루프 이름 ("run_engine")
    version = models.CharField(max_length=64)  # APP_VERSION (운영은 이미지 태그 = 커밋 해시, 없으면 "dev")
    host = models.CharField(max_length=128)
    pid = models.IntegerField()
    started_at = models.DateTimeField()
    beat_at = models.DateTimeField()  # 마지막으로 동작한 시각
    halted = models.BooleanField(default=False)  # 새 모의 매수 중단 스위치 (PAPER_ROOT/data/HALT)
    broker_ready = models.BooleanField(default=False)  # 증권사 조회 키가 있는지
    last_tick_ms = models.IntegerField(null=True, blank=True)  # 마지막 한 바퀴에 걸린 시간
    step_errors = models.JSONField(default=list, blank=True)  # [{"at", "step", "error"}] 최신순 최대 20
    limits = models.JSONField(default=dict, blank=True)  # 하루 한도 (aiDailyBudgetUsd 등)

    class Meta:
        db_table = "engine_status"

    def __str__(self) -> str:
        return f"{self.name} {self.version} {self.beat_at:%Y-%m-%d %H:%M:%S}"
