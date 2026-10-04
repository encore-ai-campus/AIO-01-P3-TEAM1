"""longterm 테스트 공용: 가짜 조회 클라이언트(장 달력·일봉·수급·종목), 가짜 DART·뉴스·LLM, 고정 엔진 설정, 보유 만들기.

실제 증권사·DART·Google·LLM을 부르지 않는다. 시각은 테스트가 정한다 (KST 고정 날짜 — 오늘 날짜·시각에 기대지 않는다).
가짜 장 달력의 "오늘"은 FakeClient.today (기본 2026-10-02 금요일), 국내 정규장 09:00~15:30 KST.
"""
import copy
from dataclasses import replace
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.core.cache import cache
from django.utils import timezone
from paper_engine.config import Config
from rest_framework.test import APIClient

from config import engine
from longterm import conf, daily, sources
from longterm.models import DailyMoveNote
from trading.models import PaperAccount, PaperOrder

KST = ZoneInfo("Asia/Seoul")
NEW_YORK = ZoneInfo("America/New_York")
FRIDAY = date(2026, 10, 2)
CFG = Config(kiwoom_appkey=None, kiwoom_secretkey=None, token_cache=None, markets=("KR", "US"), broker="toss",
             paper_capital_krw=10_000_000)
LISTED = {
    "KOSPI": [{"symbol": "005930", "name": "삼성전자"}, {"symbol": "000660", "name": "SK하이닉스"},
              {"symbol": "069500", "name": "KODEX 200"}, {"symbol": "105560", "name": "KB금융"}],
    "KOSDAQ": [{"symbol": "247540", "name": "에코프로비엠"}, {"symbol": "229200", "name": "KODEX 코스닥150"},
               {"symbol": "035720", "name": "카카오게임즈"}],
    "NASDAQ": [{"symbol": "AAPL", "name": "Apple"}],
}
TYPES = {"069500": "ETF", "229200": "ETF"}
# 마지막 날 종가: 005930 +6% (KODEX 200 +0.5%), 247540 −2% (KODEX 코스닥150 −1.8%), 000660 +1%
SERIES = {
    "005930": [100 + (i % 3) for i in range(24)] + [100, 106],
    "069500": [100.0] * 25 + [100.5],
    "247540": [200 + (i % 2) * 4 for i in range(24)] + [200, 196],
    "229200": [50.0] * 25 + [49.1],
    "000660": [300 + (i % 4) for i in range(24)] + [300, 303],
    "035720": [20.0] * 25 + [20.0],
    "105560": [70.0] * 26,
}


def kst(day: date, hour: int, minute: int = 0) -> datetime:
    return datetime.combine(day, time(hour, minute), tzinfo=KST)


class FakeClient:
    """엔진 조회 클라이언트와 같은 메서드·반환 형식 (장기투자가 쓰는 것만)."""

    def __init__(self):
        self.today = FRIDAY
        self.holiday = False  # 오늘 국내 휴장
        self.series = copy.deepcopy(SERIES)
        self.last_bar: dict[str, date] = {}  # 종목별 마지막 봉 날짜 (없으면 today) — 그날 봉이 아직 없음을 흉내 낸다
        self.investors: dict[str, list[dict]] = {}
        self.calls: list[str] = []

    def _entry(self, day: date, market: str, open_: bool = True) -> dict:
        if market == "KR":
            if not open_:
                return {"date": f"{day}", "integrated": None}
            start, end = datetime.combine(day, time(9), KST), datetime.combine(day, time(15, 30), KST)
            return {"date": f"{day}", "integrated": {"regularMarket": {"startTime": start.isoformat(),
                                                                       "endTime": end.isoformat()}}}
        start, end = datetime.combine(day, time(9, 30), NEW_YORK), datetime.combine(day, time(16), NEW_YORK)
        return {"date": f"{day}", "regularMarket": {"startTime": start.isoformat(), "endTime": end.isoformat()}}

    def market_calendar(self, market):
        self.calls.append("market_calendar")
        prev = self.today - timedelta(days=3 if self.today.weekday() == 0 else 1)
        nxt = self.today + timedelta(days=3 if self.today.weekday() == 4 else 1)
        return {"previousBusinessDay": self._entry(prev, market), "today": self._entry(self.today, market,
                                                                                       not self.holiday),
                "nextBusinessDay": self._entry(nxt, market)}

    def listed_stocks(self, exchange):
        self.calls.append("listed_stocks")
        return [{**s, "market": exchange} for s in LISTED.get(exchange, [])]

    def stocks(self, symbols):
        self.calls.append("stocks")
        out = []
        for exchange, items in LISTED.items():
            for s in items:
                if s["symbol"] in symbols:
                    out.append({**s, "market": exchange, "currency": "USD" if exchange == "NASDAQ" else "KRW",
                                "securityType": TYPES.get(s["symbol"], "STOCK"), "status": "ACTIVE"})
        return out

    def daily_candles(self, symbol, count=200):
        self.calls.append(f"daily_candles:{symbol}")
        closes = self.series.get(symbol, [10.0, 10.0])
        end = self.last_bar.get(symbol, self.today)
        n = len(closes)
        return [{"timestamp": f"{end - timedelta(days=n - 1 - i)}T00:00:00+09:00", "openPrice": f"{c}",
                 "highPrice": f"{c}", "lowPrice": f"{c}", "closePrice": f"{c}", "volume": "1000"}
                for i, c in enumerate(closes)][-count:]

    def investor_trading(self, symbol, count=20):
        self.calls.append(f"investor_trading:{symbol}")
        default = [{"date": f"{self.today}", "foreigner": {"netBuyVolume": "120"},
                    "institution": {"netBuyVolume": "-30"}, "individual": {"netBuyVolume": "-90"}}]
        return self.investors.get(symbol, default)[:count]


FUND = {
    "annual": {"period": "2025.01.01 ~ 2025.12.31", "revenue": 200, "operatingIncome": 30, "netIncome": 20,
               "previousYear": {"revenue": 160, "operatingIncome": 25, "netIncome": 10}},
    "interim": {"report": "반기", "period": "2026.01.01 ~ 2026.06.30", "revenue": 110, "operatingIncome": 20,
                "netIncome": 15, "samePeriodLastYear": {"revenue": 100, "operatingIncome": 18, "netIncome": 8}},
    "ttm": {"revenue": 210, "operatingIncome": 32, "netIncome": 30},
    "balance": {"totalAssets": 1000, "totalLiabilities": 400, "totalEquity": 600},
    "reported": {"period": "2026.01.01 ~ 2026.06.30", "annualized": False, "debtRatio": 0.6, "currentRatio": 1.5},
    "ratios": {"operatingMargin": 0.15, "netIncomeToOperatingIncome": 0.94, "nonOperatingShareOfPretaxIncome": 0.1},
    "nonOperating": {"period": "2026.01.01 ~ 2026.06.30", "financeCosts": 4, "pretaxIncome": 22},
    "cashFlow": {"period": "2026.01.01 ~ 2026.06.30", "operatingCashFlow": 25, "netIncome": 15,
                 "samePeriodLastYear": {"operatingCashFlow": 11, "netIncome": 8}},
    "report": {"label": "2026 반기보고서", "receivedAt": "2026-08-14", "rceptNo": "20260814000123"},
}


def fund(**changes) -> dict:
    """FUND를 복사해 "묶음.키" 값을 바꾼다."""
    f = copy.deepcopy(FUND)
    for path, value in changes.items():
        *parents, last = path.split(".")
        target = f
        for p in parents:
            target = target[p]
        target[last] = value
    return f


class FakeDart:
    """sources.dart_client()가 돌려주는 DartClient 자리 (부른 기록을 남긴다)."""

    def __init__(self):
        self.items: dict[str, list[dict]] = {}
        self.funds: dict[str, dict | None] = {"005930": fund()}
        self.filed: dict[date, list[str]] = {}
        self.industries: dict[str, str] = {"105560": "64992"}
        self.calls: list[str] = []
        self.fail = False

    def disclosures(self, symbol, today, days=30):
        self.calls.append(f"disclosures:{symbol}:{today}:{days}")
        return {"items": self.items.get(symbol, []), "insiderOwnershipReportCount": 0}

    def fundamentals(self, symbol, price, today):
        self.calls.append(f"fundamentals:{symbol}")
        if self.fail:
            raise OSError("DART 연결 실패")
        return copy.deepcopy(self.funds.get(symbol))

    def periodic_filings(self, day):
        self.calls.append(f"periodic_filings:{day}")
        if self.fail:
            raise OSError("DART 연결 실패")
        return [{"symbol": s, "corpName": s, "title": "반기보고서", "rceptNo": "1", "date": f"{day}"}
                for s in self.filed.get(day, [])]

    def industry_code(self, symbol):
        self.calls.append(f"industry_code:{symbol}")
        return self.industries.get(symbol, "264")


class FakeLlm:
    """전용 LLM 클라이언트 자리. outputs를 차례로 돌려준다 (예외면 던진다)."""

    def __init__(self, *outputs, cost_per_call: float = 0.002):
        self.outputs = list(outputs)
        self.calls: list[tuple[str, str, str]] = []
        self.cost = 0.5
        self.cost_per_call = cost_per_call

    def complete_json(self, model, system, user):
        self.calls.append((model, system, user))
        self.cost += self.cost_per_call
        out = self.outputs.pop(0) if self.outputs else {"headline": "", "summary": [], "drivers": []}
        if isinstance(out, Exception):
            raise out
        return out


@pytest.fixture(autouse=True)
def longterm_setup(monkeypatch):
    """캐시를 비우고 엔진 설정·바깥 자료를 고정한다 (가짜를 끼우지 않으면 증권사·DART·LLM 없음, 뉴스 없음)."""
    cache.clear()
    monkeypatch.setattr(engine, "engine_config", lambda: CFG)
    monkeypatch.setattr(engine, "broker_client", lambda: None)
    monkeypatch.setattr(conf, "_dotenv", lambda: {})  # 개발자 .env의 DAILY_MOVE_* 값을 읽지 않는다
    for key in ("DAILY_MOVE_AT", "THESIS_CHECK_AT", "DAILY_MOVE_MODEL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(daily, "llm_client", lambda: None)
    monkeypatch.setattr(sources, "dart_client", lambda: None)
    monkeypatch.setattr(sources, "news_items", lambda name: [])
    monkeypatch.setattr(sources, "broker_headlines", lambda name, symbol: [])
    yield
    cache.clear()


@pytest.fixture
def fake(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(engine, "broker_client", lambda: client)
    return client


@pytest.fixture
def dart(monkeypatch):
    found = FakeDart()
    monkeypatch.setattr(sources, "dart_client", lambda: found)
    return found


@pytest.fixture
def llm(monkeypatch):
    """LLM 키·모델이 있는 설정 + 가짜 LLM. 테스트가 llm.outputs를 채운다."""
    client = FakeLlm()
    monkeypatch.setattr(engine, "engine_config", lambda: replace(CFG, llm_api_key="test-key", approver="approver-model"))
    monkeypatch.setattr(daily, "llm_client", lambda: client)
    return client


@pytest.fixture
def alice(django_user_model):
    return django_user_model.objects.create_user("alice", password="pw-alice-1234")


@pytest.fixture
def bob(django_user_model):
    return django_user_model.objects.create_user("bob", password="pw-bob-1234")


def client_for(user) -> APIClient:
    api = APIClient()
    api.force_login(user)
    return api


def hold(user, symbol: str, name: str, *, status: str = "EXIT_WATCHING", market: str = "KR",
         style: str = "swing") -> PaperOrder:
    account, _ = PaperAccount.objects.get_or_create(
        user=user, defaults={"name": user.username, "initial_capital_krw": 10_000_000, "cash_krw": 10_000_000})
    return PaperOrder.objects.create(
        account=account, requested_by=user.username, symbol=symbol, name=name, market=market,
        currency="KRW" if market == "KR" else "USD", order_type="MARKET", quantity=10, entry_price=100,
        status=status, filled_quantity=10, fill_price=100, created_at=timezone.now(), style=style)


def make_note(symbol: str, name: str, day: date, **over) -> DailyMoveNote:
    fields = {
        "symbol": symbol, "name": name, "market": "KR", "day": day, "as_of": kst(day, 15, 30), "close": 106.0,
        "prev_close": 100.0, "change_rate": 0.06, "proxy_symbol": "069500", "proxy_name": "KODEX 200",
        "proxy_change_rate": 0.005, "excess_change_rate": 0.055, "volatility20": 0.02,
        "flows": {"foreign": 0.12, "institution": -0.03, "individual": -0.09},
        "headline": f"{name} +6.0% · 시장 대비 +5.5%p", "summary": ["같은 날 나온 뚜렷한 소식을 찾지 못했어요."],
        "drivers": [], "uncertain": True, "method": "template", "evidence": [], "missing": ["업종: 업종 자료 없음"],
        "created_at": kst(day, 16, 31),
    }
    fields.update(over)
    return DailyMoveNote.objects.create(**fields)
