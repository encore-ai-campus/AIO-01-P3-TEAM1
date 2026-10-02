import json
from datetime import datetime, timedelta, timezone

from paper_engine import scheduler
from paper_engine.judge import screen
from paper_engine.scheduler import Reservation, ReservationBook

KST = timezone(timedelta(hours=9))


def t(day, hh, mm=0):
    return datetime(2026, 9, day, hh, mm, tzinfo=KST)


def session(start, end):
    return {"startTime": start.isoformat(), "endTime": end.isoformat()}


US = {"previousBusinessDay": {"date": "2026-09-28", "regularMarket": session(t(28, 22, 30), t(29, 5))},
      "today": {"date": "2026-09-29", "regularMarket": session(t(29, 22, 30), t(30, 5))},
      "nextBusinessDay": {"date": "2026-09-30", "regularMarket": None}}  # 휴장
KR = {"previousBusinessDay": {"integrated": {"regularMarket": session(t(28, 9), t(28, 15, 30))}},
      "today": {"integrated": {"regularMarket": session(t(29, 9), t(29, 15, 30))}},
      "nextBusinessDay": {"integrated": None}}


def test_regular_sessions_handle_both_formats_and_holidays():
    assert scheduler.regular_sessions(US) == [(t(28, 22, 30), t(29, 5)), (t(29, 22, 30), t(30, 5))]
    assert scheduler.regular_sessions(KR) == [(t(28, 9), t(28, 15, 30)), (t(29, 9), t(29, 15, 30))]


def test_scan_window_is_one_hour_before_open():
    sessions = scheduler.regular_sessions(KR)
    assert scheduler.upcoming_scan(sessions, t(29, 7, 59)) is None
    assert scheduler.upcoming_scan(sessions, t(29, 8)) == t(29, 9)
    assert scheduler.upcoming_scan(sessions, t(29, 8, 59)) == t(29, 9)
    assert scheduler.upcoming_scan(sessions, t(29, 9)) is None


def res(created_at):
    return Reservation(1, "US", "SELL", "FIG", "피그마", "3", created_at.isoformat(), "20", "alice", order_id=4)


def test_reservation_runs_in_first_session_starting_after_it():
    sessions = scheduler.regular_sessions(US)
    r = res(t(29, 16))
    assert not r.is_due(sessions, t(29, 22, 29))
    assert r.is_due(sessions, t(29, 22, 30))
    assert r.is_due(sessions, t(30, 2))
    # 정규장 중에 예약하면 그 장에서는 실행하지 않는다
    assert not res(t(30, 1)).is_due(sessions, t(30, 2))
    assert scheduler.next_session_start(sessions, t(30, 1)) is None  # 다음 영업일이 휴장


def test_last_session_end():
    sessions = scheduler.regular_sessions(KR)
    assert scheduler.last_session_end(sessions, t(28, 8)) is None
    assert scheduler.last_session_end(sessions, t(29, 10)) == t(28, 15, 30)
    assert scheduler.last_session_end(sessions, t(29, 15, 30)) == t(29, 15, 30)


class FakeRedis:
    def __init__(self):
        self.kv, self.sets = {}, {}

    def incr(self, k):
        self.kv[k] = int(self.kv.get(k, 0)) + 1
        return self.kv[k]

    def set(self, k, v, nx=False, ex=None):
        if nx and k in self.kv:
            return False
        self.kv[k] = v
        return True

    def get(self, k):
        return self.kv.get(k)

    def delete(self, *ks):
        return sum(self.kv.pop(k, None) is not None for k in ks)

    def sadd(self, k, m):
        self.sets.setdefault(k, set()).add(m)

    def srem(self, k, m):
        if m in self.sets.get(k, set()):
            self.sets[k].remove(m)
            return 1
        return 0

    def smembers(self, k):
        return set(self.sets.get(k, set()))


def test_reservation_book_roundtrip_and_single_removal():
    book = ReservationBook(FakeRedis())
    a = book.add(market="KR", side="BUY", symbol="005930", name="삼성전자", quantity="2",
                 created_at=t(29, 16).isoformat(), reference_price="273500", requested_by="alice",
                 target="300000", stop="260000", days=20)
    b = book.add(market="US", side="SELL", symbol="FIG", name="피그마", quantity="3",
                 created_at=t(29, 16).isoformat(), reference_price="20", requested_by="strategy:2", order_id=7)
    assert [r.id for r in book.all()] == [1, 2]
    assert a.label == "#1 삼성전자 (005930) 2주 시장가 매수 (목표 300000 / 손절 260000, 20일) · 요청 alice"
    assert b.label == "#2 피그마 (FIG) 모의 주문 #7 전량 시장가 매도 · 요청 strategy:2"
    assert book.all()[1].order_id == 7 and book.all()[0].days == 20
    assert book.remove(1) and not book.remove(1)
    assert [r.id for r in book.all()] == [2]


def test_claim_scan_once_per_session():
    r = FakeRedis()
    assert scheduler.claim_scan(r, 1, t(29, 9))
    assert not scheduler.claim_scan(r, 1, t(29, 9))
    assert scheduler.claim_scan(r, 2, t(29, 9))


def test_scan_result_roundtrip():
    r = FakeRedis()
    scheduler.save_scan_result(r, 3, {"at": "2026-09-29T08:00:00+09:00", "picks": [1]})
    assert scheduler.load_scan_result(r, 3)["picks"] == [1]
    assert scheduler.load_scan_result(r, 3, "2026-09-29")["picks"] == [1]
    assert scheduler.load_scan_result(r, 4) is None


# --- 종목 선별 규칙 ---

def candles(closes, spread=0.03):
    return [{"closePrice": str(c), "highPrice": str(c * (1 + spread / 2)),
             "lowPrice": str(c * (1 - spread / 2))} for c in closes]


def test_eligible_excludes_funds_and_suspended():
    base = {"securityType": "STOCK", "status": "ACTIVE", "leverageFactor": None}
    assert screen.eligible(base) is None
    assert screen.eligible(base | {"securityType": "ETF"})
    assert screen.eligible(base | {"securityType": "ETN"})
    assert screen.eligible(base | {"koreanMarketDetail": {"krxTradingSuspended": True}})


def test_score_uptrend_passes_and_rules_reject():
    # 완만한 상승 + 눌림: 추세 위, RSI 중간대
    up = [100 * (1.004 ** i) * (1 + 0.02 * ((-1) ** i)) for i in range(120)]
    pick = screen.score("A", "상승", candles(up), 1e10)
    assert isinstance(pick, screen.Pick) and pick.score >= 60
    down = [200 * (0.995 ** i) for i in range(120)]
    assert screen.score("B", "하락", candles(down), 1e10) == "60일선 아래"
    assert screen.score("C", "짧음", candles(up[:30]), 1e10) == "일봉 30개"
    quiet = [100 + 0.005 * i + 0.05 * ((-1) ** i) for i in range(120)]  # 추세 위지만 움직임이 작다
    assert screen.score("D", "잠잠", candles(quiet, spread=0.002), 1e10).startswith("ATR 비율")


# --- 전략 ---

def test_strategy_book_defaults_once_and_status():
    from paper_engine.strategies import StrategyBook
    book = StrategyBook(FakeRedis())
    assert [s.market for s in book.ensure_defaults(("KR", "US"))] == ["KR", "US"]
    assert book.ensure_defaults() == []
    s = book.create(name="국내스윙", market="KR", action="confirm", max_amount=1_000_000.0,
                    max_currency="KRW")
    assert s.id == 3 and s.active and "종목당 1,000,000원" in s.summary()
    assert book.set_status(3, "stopped").status == "stopped"
    assert [x.active for x in book.all()] == [True, True, False]
    assert s.max_amount_krw(1400.0) == 1_000_000.0
    us = book.create(name="미국", market="US", max_amount=500.0, max_currency="USD")
    assert us.max_amount_krw(1400.0) == 700_000.0


def test_stock_info_finds_screening_reason(tmp_path, monkeypatch):
    from paper_engine import info
    from paper_engine.records.store import Store
    from paper_engine.strategies import StrategyBook
    monkeypatch.setattr(info, "RUNS_DIR", tmp_path / "runs")
    r = FakeRedis()
    s = StrategyBook(r).create(name="기본 국내 선별", market="KR")
    scheduler.save_scan_result(r, s.id, {
        "at": "2026-09-29T08:00:00+09:00", "market": "KR", "strategy": {"id": s.id},
        "picks": [{"symbol": "096770", "name": "SK이노베이션", "score": 79.0}],
        "dropped": [{"symbol": "005380", "name": "현대차", "reason": "RSI 80"}],
        "excluded": [{"symbol": "069500", "name": "KODEX 200", "reason": "종목 유형 ETF"}],
        "analyzed": ["096770"]})
    found = info.stock("sk이노베이션", r, Store(":memory:"))
    assert found["screening"][0]["status"] == "규칙 통과" and found["screening"][0]["analyzed"]
    assert info.stock("현대차", r, Store(":memory:"))["screening"][0]["reason"] == "RSI 80"
    missing = info.stock("SK온", r, Store(":memory:"))
    assert "SK이노베이션(096770)" in missing["knownStocks"]


def test_stock_info_reads_latest_analysis(tmp_path, monkeypatch):
    from paper_engine import info
    runs = tmp_path / "runs"
    runs.mkdir()
    log = {"startedAt": "2026-09-29T08:01:00+09:00", "strategy": {"id": 1, "name": "기본 국내 선별"},
           "results": [{"snapshot": {"symbol": "096770", "name": "SK이노베이션", "lastPrice": 146400,
                                     "indicators": {"rsi14": 56}, "news": [{"title": "배터리 호재"}],
                                     "webResearch": {"researchers": [{"id": "R1", "findings": [
                                         {"claim": "수주", "direction": "POSITIVE", "date": "2026-09-28",
                                          "sourceTitle": "뉴스", "sourceVerified": True, "sourceUrl": "x"}],
                                         "upcomingEvents": []}]}},
                        "candidates": [{"id": "S1", "proposer": "m", "raw": {"big": "x" * 1000},
                                        "selected": True, "passed": True, "score": 72,
                                        "scenario": {"entry_price": 145000}, "final": None,
                                        "critiques": [{"analyst": "a", "score": 70, "comment": "좋음"}],
                                        "approval": {"approved": True, "reason": "근거 충분"}}]}]}
    (runs / "20260929-080100-s1.json").write_text(json.dumps(log, ensure_ascii=False))
    monkeypatch.setattr(info, "RUNS_DIR", runs)
    (view,) = info.analyses("096770")
    assert view["runFile"] == "runs/20260929-080100-s1.json" and view["strategy"]["id"] == 1
    assert view["news"] == ["배터리 호재"] and view["webResearch"][0]["findings"][0]["claim"] == "수주"
    c = view["candidates"][0]
    assert c["scenario"] == {"entry_price": 145000} and c["approval"]["reason"] == "근거 충분"
    assert "raw" not in c


def test_trading_sessions_include_extended_hours():
    kr = {"today": {"integrated": {"preMarket": session(t(29, 8), t(29, 9)),
                                   "regularMarket": session(t(29, 9), t(29, 15, 30)),
                                   "afterMarket": session(t(29, 15, 30), t(29, 20))}},
          "previousBusinessDay": {"integrated": None}, "nextBusinessDay": {"integrated": None}}
    sessions = scheduler.trading_sessions(kr)
    assert scheduler.current_session(sessions, t(29, 17)) == (t(29, 15, 30), t(29, 20))
    assert scheduler.current_session(scheduler.regular_sessions(kr), t(29, 17)) is None
    assert scheduler.current_session(sessions, t(29, 21)) is None


def test_near_open_window():
    from paper_engine.__main__ import Service
    from paper_engine.config import Config
    service = Service.__new__(Service)
    service.cfg = Config(None, None, None, markets=("KR", "US"))
    service.sessions = lambda market, extended=False: scheduler.regular_sessions(KR if market == "KR" else US)
    import paper_engine.__main__ as main

    class Clock(datetime):
        now_value = None

        @classmethod
        def now(cls, tz=None):
            return cls.now_value

    original = main.datetime
    main.datetime = Clock
    try:
        for when, expected in [(t(29, 8, 57, ), False), (t(29, 8, 58), True), (t(29, 9, 2), True),
                               (t(29, 9, 3), False), (t(29, 22, 29), True)]:
            Clock.now_value = when
            assert service.near_open(120) is expected, when
        service.cfg = Config(None, None, None)  # 국내만 운영하면 미국 정규장 시작은 보지 않는다
        Clock.now_value = t(29, 22, 29)
        assert service.near_open(120) is False
    finally:
        main.datetime = original
