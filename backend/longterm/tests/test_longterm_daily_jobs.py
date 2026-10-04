"""오늘의 내 종목 뉴스 작업 (longterm.daily, jobs.tick): 때, 대상, 종목·날짜당 한 번, 알림 하나, LLM, 재시도.

시각은 고정한다 (2026-10-02 금요일 KST). 실제 증권사·DART·뉴스·LLM을 부르지 않는다.
"""
from datetime import date, timedelta

import pytest
from django.core.cache import cache
from notifications.models import Notification, OutboxMessage
from paper_engine.wording import forbidden_phrases

from longterm import daily, jobs
from longterm.models import DailyMoveNote

from .conftest import FRIDAY, hold, kst

pytestmark = pytest.mark.django_db


class Log(list):
    def __call__(self, text):
        self.append(text)


@pytest.fixture
def holdings(alice, bob):
    """alice: 삼성전자(스윙)·에코프로비엠(코스닥) 보유. bob: 삼성전자(장기)·애플(미국)·SK하이닉스(체결 대기)."""
    hold(alice, "005930", "삼성전자")
    hold(alice, "247540", "에코프로비엠")
    hold(bob, "005930", "삼성전자", style="long")
    hold(bob, "AAPL", "Apple", market="US")
    hold(bob, "000660", "SK하이닉스", status="ENTRY_PENDING")


def notes():
    return {n.symbol: n for n in DailyMoveNote.objects.all()}


def test_jobs_tick_does_nothing_when_off(fake, holdings):
    jobs.tick(kst(FRIDAY, 16, 40), Log())  # 루트 conftest.py가 LONGTERM_JOBS=off
    assert notes() == {} and fake.calls == []


def test_jobs_tick_runs_both_jobs_when_on(fake, holdings, monkeypatch):
    monkeypatch.setenv("LONGTERM_JOBS", "on")
    ran = []
    monkeypatch.setattr(daily, "tick", lambda now, log: ran.append("daily"))
    monkeypatch.setattr(jobs.theses, "tick", lambda now, log: (_ for _ in ()).throw(RuntimeError("고장")))
    log = Log()
    jobs.tick(kst(FRIDAY, 18, 30), log)
    assert ran == ["daily"] and log == ["장기투자 펀더멘털 점검 실패: RuntimeError: 고장"]


def test_jobs_tick_needs_the_broker(holdings, monkeypatch):
    monkeypatch.setenv("LONGTERM_JOBS", "on")
    monkeypatch.setattr(daily, "tick", lambda now, log: pytest.fail("증권사 조회가 없으면 돌지 않는다"))
    jobs.tick(kst(FRIDAY, 16, 40), Log())


@pytest.mark.parametrize("hour, minute, at, made", [
    (16, 29, None, False),  # DAILY_MOVE_AT(16:30) 전
    (16, 30, None, True),
    (23, 59, None, True),
    (15, 35, "15:00", False),  # 시각은 지났지만 기준일이 아직 전 거래일 (정규장 종료 + 10분 전)
    (15, 40, "15:00", True),
])
def test_daily_move_waits_for_its_time_and_the_close_basis(fake, holdings, monkeypatch, hour, minute, at, made):
    if at:
        monkeypatch.setenv("DAILY_MOVE_AT", at)
    daily.tick(kst(FRIDAY, hour, minute), Log())
    assert bool(notes()) is made


def test_daily_move_skips_holidays_and_the_next_morning(fake, holdings):
    fake.holiday = True
    daily.tick(kst(FRIDAY, 17, 0), Log())
    assert notes() == {}
    fake.holiday = False
    daily.tick(kst(FRIDAY + timedelta(days=1), 0, 5), Log())  # 다음 날 0시가 넘으면 그날 것은 만들지 않는다
    assert notes() == {}


def test_daily_move_builds_one_note_per_held_kr_symbol(fake, holdings):
    log = Log()
    daily.tick(kst(FRIDAY, 16, 40), log)
    found = notes()
    assert set(found) == {"005930", "247540"}  # 미국 종목·체결 대기는 빼고, 두 사람의 삼성전자는 한 번
    s = found["005930"]
    assert (s.day, s.close, s.prev_close) == (FRIDAY, 106, 100)
    assert s.change_rate == pytest.approx(0.06) and s.proxy_symbol == "069500" and s.proxy_name == "KODEX 200"
    assert s.proxy_change_rate == pytest.approx(0.005) and s.excess_change_rate == pytest.approx(0.055)
    assert s.as_of == kst(FRIDAY, 15, 30)
    assert s.flows == {"foreign": 0.12, "institution": -0.03, "individual": -0.09}
    assert s.method == "template" and s.llm_model is None and s.cost_usd is None
    assert s.missing == ["업종: 업종 자료 없음", "공시: DART 키가 없어 받지 못했어요"]
    assert [e["kind"] for e in s.evidence] == ["flow", "flow", "flow"]
    assert s.evidence[0]["source"] == "토스증권 Open API(개발)"
    e = found["247540"]
    assert e.proxy_symbol == "229200" and e.proxy_name == "KODEX 코스닥150"  # 코스닥 종목
    assert e.headline == "오늘은 시장과 비슷하게 움직였어요"  # 초과 등락 −0.2%p < 1%p, 변동성보다 작고 소식 없음
    for note in found.values():
        assert forbidden_phrases(" ".join([note.headline, *note.summary]), causal=True) == []
    assert "오늘의 내 종목 뉴스 알림 2명" in log


def test_daily_move_notifies_each_holder_once_on_the_web(fake, holdings, alice, bob):
    now = kst(FRIDAY, 16, 40)
    daily.tick(now, Log())
    a = Notification.objects.get(user=alice)
    assert a.kind == "daily_move" and a.link == "/" and a.title == "오늘의 내 종목 뉴스 · 2종목"
    assert a.body.splitlines() == ["삼성전자 +6.0% · 시장 대비 +5.5%p", "에코프로비엠 −2.0% · 시장 대비 −0.2%p",
                                   "등락의 원인을 단정하지 않습니다. 같은 날 나온 소식을 모은 것이며 투자 권유가 아닙니다."]
    assert Notification.objects.get(user=bob).title == "오늘의 내 종목 뉴스 · 1종목"
    assert OutboxMessage.objects.count() == 0  # Discord로 보내지 않는다
    assert forbidden_phrases(a.title + a.body) == []
    daily.tick(now + timedelta(minutes=5), Log())
    cache.clear()  # 엔진이 다시 떠도 (메모리 캐시가 비어도)
    daily.tick(now + timedelta(minutes=10), Log())
    assert DailyMoveNote.objects.count() == 2 and Notification.objects.count() == 2


def test_daily_move_next_trading_day_notifies_again(fake, holdings, alice):
    daily.tick(kst(FRIDAY, 16, 40), Log())
    Notification.objects.update(created_at=kst(FRIDAY, 16, 40))  # 알림 시각 = 그 바퀴 시각
    monday = date(2026, 10, 5)
    fake.today = monday
    cache.clear()  # 장 달력 60초 캐시
    daily.tick(kst(monday, 16, 40), Log())
    assert DailyMoveNote.objects.filter(day=monday).count() == 2
    assert Notification.objects.filter(user=alice, kind="daily_move").count() == 2


def test_daily_move_limits_work_per_tick_and_notifies_after_all(fake, alice):
    for symbol, name in (("005930", "삼성전자"), ("247540", "에코프로비엠"), ("000660", "SK하이닉스"),
                         ("035720", "카카오게임즈"), ("105560", "KB금융")):
        hold(alice, symbol, name)
    now = kst(FRIDAY, 16, 40)
    daily.tick(now, Log())
    assert DailyMoveNote.objects.count() == daily.PER_TICK and Notification.objects.count() == 0
    daily.tick(now + timedelta(seconds=5), Log())
    assert DailyMoveNote.objects.count() == 5
    assert Notification.objects.get(user=alice).body.splitlines()[-2] == "외 2종목"


def test_daily_move_retries_a_missing_bar_then_gives_up(fake, alice):
    hold(alice, "005930", "삼성전자")
    hold(alice, "000660", "SK하이닉스")
    fake.last_bar["000660"] = FRIDAY - timedelta(days=1)  # 그날 봉이 아직 없다
    now, log = kst(FRIDAY, 16, 40), Log()
    daily.tick(now, log)
    assert set(notes()) == {"005930"} and Notification.objects.count() == 0  # 다 끝나야 알린다
    assert any("SK하이닉스(000660) 실패: NotReady" in line for line in log)
    calls = len(fake.calls)
    daily.tick(now + timedelta(minutes=1), Log())
    assert len(fake.calls) == calls  # 10분 동안 다시 하지 않는다
    daily.tick(now + timedelta(minutes=11), Log())
    daily.tick(now + timedelta(minutes=22), Log())  # 세 번째 실패 → 그날은 건너뛴다
    assert Notification.objects.get(user=alice).title == "오늘의 내 종목 뉴스 · 1종목"
    fake.last_bar.clear()
    daily.tick(now + timedelta(minutes=40), Log())
    assert set(notes()) == {"005930"}


def test_daily_move_evidence_from_dart_and_news(fake, dart, alice, monkeypatch):
    hold(alice, "005930", "삼성전자")
    dart.items["005930"] = [{"date": "2026-10-02", "title": "단일판매ㆍ공급계약체결", "filer": "삼성전자",
                             "rceptNo": "20261002000555"}]
    monkeypatch.setattr("longterm.sources.news_items", lambda name: [
        {"publishedAt": "2026-10-02T02:00:00+00:00", "title": f"{name} 반도체 수출 늘어", "source": "연합뉴스"}])
    monkeypatch.setattr("longterm.sources.broker_headlines", lambda name, symbol: [
        {"publishedAt": "2026-10-01T23:30:00+00:00", "title": "삼성전자 목표주가 9만원으로 상향", "source": "한국경제"}])
    daily.tick(kst(FRIDAY, 16, 40), Log())
    note = notes()["005930"]
    assert [e["kind"] for e in note.evidence] == ["disclosure", "flow", "flow", "flow", "broker", "news"]
    assert note.evidence[0]["url"] == "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261002000555"
    assert "disclosures:005930:2026-10-02:0" in dart.calls  # 그날 하루만
    assert note.missing == ["업종: 업종 자료 없음"]
    assert note.summary[-1] == "같은 날 공시 1건 · 증권사 목표가 헤드라인 1건이 있었어요."


def test_daily_move_records_missing_data(fake, alice, monkeypatch):
    hold(alice, "005930", "삼성전자")
    fake.investors["005930"] = []
    fake.series["069500"] = [100.0]  # 시장 대용 ETF 등락을 구할 수 없음

    def boom(name):
        raise OSError("RSS 실패")
    monkeypatch.setattr("longterm.sources.news_items", boom)
    daily.tick(kst(FRIDAY, 16, 40), Log())
    note = notes()["005930"]
    assert note.proxy_change_rate is None and note.excess_change_rate is None and note.flows is None
    assert note.missing == ["시장: KODEX 200 종가를 받지 못했어요", "업종: 업종 자료 없음",
                            "수급: 그날 투자자별 매매 자료를 받지 못했어요", "공시: DART 키가 없어 받지 못했어요",
                            "뉴스: Google 뉴스 검색 결과를 받지 못했어요"]
    assert note.headline == "삼성전자 +6.0% · 시장 등락 자료 없음"


def grounded(**over):
    return {"headline": "삼성전자 +6.0%, 시장 대비 +5.5%p", "summary": ["외국인은 거래량의 12.0%를 순매수했어요."],
            "drivers": ["E1"], "uncertain": False, **over}


def test_daily_move_llm_uses_approver_when_no_model_is_set(fake, alice, llm):
    hold(alice, "005930", "삼성전자")
    llm.outputs = [grounded()]
    daily.tick(kst(FRIDAY, 16, 40), Log())
    note = notes()["005930"]
    assert note.method == "llm" and note.llm_model == "approver-model" and note.drivers == ["E1"]
    assert note.cost_usd == pytest.approx(0.002)  # 전용 클라이언트의 호출 전후 차이
    assert llm.calls[0][0] == "approver-model"


def test_daily_move_model_setting_wins(fake, alice, llm, monkeypatch):
    monkeypatch.setenv("DAILY_MOVE_MODEL", "fast-model")
    hold(alice, "005930", "삼성전자")
    llm.outputs = [grounded(drivers=["E99"]), grounded(summary=["공시 때문에 올랐어요"])]
    log = Log()
    daily.tick(kst(FRIDAY, 16, 40), log)
    note = notes()["005930"]
    assert [c[0] for c in llm.calls] == ["fast-model", "fast-model"]
    assert note.method == "template" and note.llm_model is None and note.cost_usd == pytest.approx(0.004)
    assert any("검사 위반 → 템플릿" in line for line in log)


def test_daily_move_quiet_day_does_not_call_the_llm(fake, alice, llm):
    hold(alice, "247540", "에코프로비엠")
    daily.tick(kst(FRIDAY, 16, 40), Log())
    assert llm.calls == [] and notes()["247540"].headline == "오늘은 시장과 비슷하게 움직였어요"


def test_note_keeps_one_row_per_symbol_and_day(fake, alice):
    hold(alice, "005930", "삼성전자")
    now = kst(FRIDAY, 16, 40)
    fields = daily.build("005930", "삼성전자", FRIDAY)
    fields.pop("_violations")
    DailyMoveNote.objects.create(**fields, created_at=now)
    daily.tick(now, Log())
    assert DailyMoveNote.objects.count() == 1
