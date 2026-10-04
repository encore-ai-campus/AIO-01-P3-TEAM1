"""산 이유 API와 펀더멘털 점검 작업 (longterm.theses): 기준선, active, 점검 때(정기공시·월요일), 알림 조건, 연속 조건.

시각은 고정한다 (2026-10-02 금요일·2026-09-28 월요일 KST). 실제 증권사·DART를 부르지 않는다.
"""
from datetime import date, timedelta

import pytest
from django.core.cache import cache
from notifications.models import Notification, OutboxMessage
from paper_engine.judge import fundamentals_check as fc
from paper_engine.wording import forbidden_phrases
from trading.models import PaperAccount, Reservation

from longterm import theses
from longterm.models import InvestmentThesis, ThesisCheck

from .conftest import FRIDAY, client_for, fund, hold, kst

pytestmark = pytest.mark.django_db
MONDAY = date(2026, 9, 28)


class Log(list):
    def __call__(self, text):
        self.append(text)


def put(user, symbol, body):
    return client_for(user).put(f"/api/longterm/theses/{symbol}", body, format="json")


# --- PUT·GET·DELETE ---

def test_put_creates_thesis_with_dart_baseline(fake, dart, alice):
    response = put(alice, "005930", {"reasons": ["  반도체 업황 회복  ", "배당"], "axes": ["growth"]})
    assert response.status_code == 200
    body = response.json()
    assert body["symbol"] == "005930" and body["name"] == "삼성전자" and body["market"] == "KR"
    assert body["reasons"] == ["반도체 업황 회복", "배당"] and body["axes"] == ["growth"]
    assert list(body["baseline"]) == list(fc.KEYS)  # 처음 저장할 때의 지표 값 9개
    assert body["baseline"]["operatingMargin"] == 0.15 and body["baseline"]["roe"] == 0.05
    assert body["baselinePeriod"] == "2026 반기보고서"
    assert body["active"] is False and body["lastCheck"] is None  # 장기 보유가 없다
    assert set(body) == {"symbol", "name", "market", "reasons", "axes", "baseline", "baselinePeriod", "active",
                         "lastCheck", "createdAt", "updatedAt"}


def test_put_without_dart_keeps_an_empty_baseline(fake, alice):
    body = put(alice, "005930", {"reasons": ["오래 가져갈 회사"]}).json()
    assert body["baseline"] == {} and body["baselinePeriod"] is None and body["axes"] == []


def test_put_for_fund_like_or_us_stocks_has_no_baseline(fake, dart, alice):
    assert put(alice, "069500", {"reasons": ["지수"]}).json()["baseline"] == {}
    us = put(alice, "AAPL", {"reasons": ["아이폰"]}).json()
    assert us["market"] == "US" and us["baseline"] == {}
    assert "fundamentals:069500" not in dart.calls and "fundamentals:AAPL" not in dart.calls


def test_put_updates_reasons_and_axes_but_not_the_baseline(fake, dart, alice):
    put(alice, "005930", {"reasons": ["처음"], "axes": ["growth", "balance_sheet"]})
    dart.funds["005930"] = fund(**{"ratios.operatingMargin": 0.01})
    body = put(alice, "005930", {"reasons": ["바꾼 이유"]}).json()
    assert body["reasons"] == ["바꾼 이유"] and body["axes"] == ["growth", "balance_sheet"]  # axes를 빼면 그대로
    assert body["baseline"]["operatingMargin"] == 0.15
    assert put(alice, "005930", {"reasons": ["또"], "axes": []}).json()["axes"] == []
    assert InvestmentThesis.objects.count() == 1


@pytest.mark.parametrize("body", [
    {}, {"reasons": []}, {"reasons": ["a", "b", "c", "d"]}, {"reasons": ["   "]}, {"reasons": ["가" * 101]},
    {"reasons": "이유"}, {"reasons": [1]}, {"reasons": ["a"], "axes": ["value"]},
    {"reasons": ["a"], "axes": ["growth", "growth"]}, {"reasons": ["a"], "axes": "growth"},
    {"reasons": ["a"], "note": "x"}, ["a"],
])
def test_put_rejects_bad_bodies(fake, alice, body):
    response = put(alice, "005930", body)
    assert response.status_code == 400 and set(response.json()) == {"detail"}


def test_put_accepts_100_characters_after_trimming(fake, alice):
    assert put(alice, "005930", {"reasons": [" " + "가" * 100 + " "]}).status_code == 200


def test_put_unknown_symbol_is_404(fake, alice):
    assert put(alice, "999999", {"reasons": ["a"]}).status_code == 404


def test_list_is_mine_newest_first_with_last_check(fake, alice, bob):
    put(alice, "005930", {"reasons": ["a"]})
    put(alice, "000660", {"reasons": ["b"]})
    put(bob, "005930", {"reasons": ["c"]})
    thesis = InvestmentThesis.objects.get(user=alice, symbol="005930")
    ThesisCheck.objects.create(thesis=thesis, checked_at=kst(FRIDAY, 18), trigger="weekly", overall="solid",
                               rows=[], period="2026 반기보고서", received_at=date(2026, 8, 14))
    put(alice, "005930", {"reasons": ["a2"]})  # 고친 것이 맨 앞
    results = client_for(alice).get("/api/longterm/theses").json()["results"]
    assert [t["symbol"] for t in results] == ["005930", "000660"]
    check = results[0]["lastCheck"]
    assert check["trigger"] == "weekly" and check["receivedAt"] == "2026-08-14"
    assert check["caption"] == "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다"
    assert set(check) == {"id", "checkedAt", "trigger", "period", "receivedAt", "overall", "previousOverall", "rows",
                          "newBad", "notified", "caption"}


def test_active_follows_long_holdings(fake, alice):
    put(alice, "005930", {"reasons": ["a"]})
    hold(alice, "005930", "삼성전자", style="swing")  # 스윙 보유는 점검 대상이 아니다
    assert client_for(alice).get("/api/longterm/theses").json()["results"][0]["active"] is False
    order = hold(alice, "000660", "SK하이닉스", style="long")
    put(alice, "000660", {"reasons": ["b"]})
    assert InvestmentThesis.objects.get(symbol="000660").active is True
    order.status = "CLOSED"
    order.save()
    client_for(alice).get("/api/longterm/theses")
    assert InvestmentThesis.objects.get(symbol="000660").active is False
    account = PaperAccount.objects.get(user=alice)
    Reservation.objects.create(account=account, kind="BUY", symbol="000660", name="SK하이닉스", market="KR",
                               currency="KRW", quantity=1, style="long")  # 장 밖 장기 매수 예약도 대상
    assert client_for(alice).get("/api/longterm/theses").json()["results"][0]["active"] is True


def test_delete_removes_thesis_and_checks(fake, alice):
    put(alice, "005930", {"reasons": ["a"]})
    ThesisCheck.objects.create(thesis=InvestmentThesis.objects.get(), trigger="weekly", overall="na")
    assert client_for(alice).delete("/api/longterm/theses/005930").status_code == 204
    assert InvestmentThesis.objects.count() == 0 and ThesisCheck.objects.count() == 0
    assert client_for(alice).delete("/api/longterm/theses/005930").status_code == 404


def test_theses_need_login():
    from rest_framework.test import APIClient
    assert APIClient().get("/api/longterm/theses").status_code == 401


# --- 점검 작업 ---

def long_thesis(user, symbol="005930", name="삼성전자", baseline=None) -> InvestmentThesis:
    hold(user, symbol, name, style="long")
    return InvestmentThesis.objects.create(user=user, symbol=symbol, name=name, market="KR", reasons=["a"],
                                           baseline=baseline if baseline is not None else {})


def test_no_check_before_thesis_check_at_or_without_a_filing(fake, dart, alice):
    long_thesis(alice)
    dart.filed[FRIDAY] = ["005930"]
    theses.tick(kst(FRIDAY, 17, 59), Log())
    assert ThesisCheck.objects.count() == 0
    dart.filed[FRIDAY] = ["000660"]
    theses.tick(kst(FRIDAY, 18, 0), Log())  # 금요일: 그날 정기공시가 없는 종목은 점검하지 않는다
    assert ThesisCheck.objects.count() == 0


def test_filing_day_check_fills_an_empty_baseline_once_a_day(fake, dart, alice):
    thesis = long_thesis(alice)
    dart.filed[FRIDAY] = ["005930"]
    log = Log()
    theses.tick(kst(FRIDAY, 18, 5), log)
    check = ThesisCheck.objects.get()
    assert check.trigger == "filing" and check.period == "2026 반기보고서" and check.received_at == date(2026, 8, 14)
    assert check.previous_overall is None and check.overall == "solid" and check.new_bad == []
    assert check.notified is False and check.facts["netIncomeSamePeriod"] == 15
    margin = next(r for r in check.rows if r["key"] == "operatingMargin")
    assert margin["status"] == "na" and margin["baseline"] is None  # 이번 점검의 기준선 비교는 na
    thesis.refresh_from_db()
    assert thesis.baseline["operatingMargin"] == 0.15 and thesis.baseline_period == "2026 반기보고서"
    theses.tick(kst(FRIDAY, 19, 0), Log())
    cache.clear()
    theses.tick(kst(FRIDAY, 20, 0), Log())
    assert ThesisCheck.objects.count() == 1  # 하루 한 번 (엔진이 다시 떠도)
    assert any("005930) filing → solid" in line for line in log)


def test_filings_are_searched_once_and_read_fresh(fake, dart, alice):
    long_thesis(alice)
    dart.filed[FRIDAY] = ["005930"]
    theses.tick(kst(FRIDAY, 18, 5), Log())
    assert dart.calls.count(f"periodic_filings:{FRIDAY}") == 1
    assert "fundamentals:005930" in dart.calls


def test_monday_rechecks_every_active_thesis_even_on_holidays(fake, dart, alice, bob):
    long_thesis(alice)
    long_thesis(bob, "000660", "SK하이닉스")
    InvestmentThesis.objects.create(user=bob, symbol="035720", name="카카오게임즈", market="KR", reasons=["a"])
    fake.today, fake.holiday = MONDAY, True
    theses.tick(kst(MONDAY, 18, 0), Log())
    assert {c.thesis.symbol: c.trigger for c in ThesisCheck.objects.all()} == {"005930": "weekly",
                                                                              "000660": "weekly"}
    assert not any(c.startswith("periodic_filings") for c in dart.calls)  # 휴장일엔 정기공시를 찾지 않는다
    assert InvestmentThesis.objects.get(symbol="035720").active is False  # 장기 보유가 없다


def test_not_applicable_or_us_theses_are_not_checked(fake, dart, alice):
    long_thesis(alice, "105560", "KB금융")  # 금융업
    long_thesis(alice, "069500", "KODEX 200")  # ETF
    hold(alice, "AAPL", "Apple", market="US", style="long")
    InvestmentThesis.objects.create(user=alice, symbol="AAPL", name="Apple", market="US", reasons=["a"])
    fake.today = MONDAY
    theses.tick(kst(MONDAY, 18, 0), Log())
    assert ThesisCheck.objects.count() == 0


def test_without_dart_no_check_is_recorded(fake, alice):
    long_thesis(alice)
    fake.today = MONDAY
    log = Log()
    theses.tick(kst(MONDAY, 18, 0), log)
    assert ThesisCheck.objects.count() == 0
    assert any("DART 키가 없어" in line for line in log)


FILINGS_LOG = "정기공시 목록을 받지 못함"


def test_missing_dart_key_is_logged_once_a_day_not_every_loop(fake, alice):
    """화~금 18시 뒤에는 공시가 없으면 산 이유가 점검·포기로 끝나지 않아 루프(5초)마다 정기공시 목록을 찾는다.
    DART 키가 없을 때 그 실패를 루프마다 남기지 않는다 (그날 한 번)."""
    long_thesis(alice)
    log = Log()
    for minute in range(0, 60, 5):
        theses.tick(kst(FRIDAY, 18, minute), log)
    theses.tick(kst(FRIDAY, 23, 59), log)
    assert [line for line in log if FILINGS_LOG in line] == [
        "펀더멘털 점검: 정기공시 목록을 받지 못함 (DART 키가 없어 공시 자료를 받지 못했어요)"]
    assert ThesisCheck.objects.count() == 0
    tuesday = FRIDAY + timedelta(days=4)
    fake.today = tuesday
    cache.delete("trading:calendar:KR")  # 장 달력 캐시(60초)가 끝난 다음 날
    theses.tick(kst(tuesday, 18, 0), log)  # 다음 거래일에는 다시 한 번
    theses.tick(kst(tuesday, 18, 5), log)
    assert sum(FILINGS_LOG in line for line in log) == 2


def test_filings_failure_is_logged_once_per_failed_attempt(fake, dart, alice):
    long_thesis(alice)
    dart.fail = True
    log = Log()
    for minute in (0, 1, 5, 9):
        theses.tick(kst(FRIDAY, 18, minute), log)
    assert dart.calls.count(f"periodic_filings:{FRIDAY}") == 1  # 실패는 10분 캐시
    assert [line for line in log if FILINGS_LOG in line] == [
        "펀더멘털 점검: 정기공시 목록을 받지 못함 (공시 자료를 받지 못했어요)"]
    cache.clear()  # 10분이 지나 실패 캐시와 로그 표시가 함께 끝난 뒤
    theses.tick(kst(FRIDAY, 18, 11), log)
    assert dart.calls.count(f"periodic_filings:{FRIDAY}") == 2
    assert sum(FILINGS_LOG in line for line in log) == 2


def test_dart_failure_is_retried_later(fake, dart, alice):
    long_thesis(alice)
    fake.today = MONDAY
    dart.fail = True
    theses.tick(kst(MONDAY, 18, 0), Log())
    assert ThesisCheck.objects.count() == 0
    dart.fail = False
    cache.delete(f"longterm:fundamentals:005930:{MONDAY}")
    theses.tick(kst(MONDAY, 18, 5), Log())  # 10분 안에는 다시 하지 않는다
    assert ThesisCheck.objects.count() == 0
    theses.tick(kst(MONDAY, 18, 11), Log())
    assert ThesisCheck.objects.count() == 1


BASELINE = {"operatingMargin": 0.15, "roe": 0.05, "debtRatio": 0.6}


def test_new_bad_metric_sends_a_web_notification(fake, dart, alice):
    long_thesis(alice, baseline=BASELINE)
    dart.funds["005930"] = fund(**{"ratios.operatingMargin": -0.02, "reported.currentRatio": 0.7})
    fake.today = MONDAY
    theses.tick(kst(MONDAY, 18, 0), Log())
    check = ThesisCheck.objects.get()
    assert check.new_bad == ["operatingMargin", "currentRatio"] and check.overall == "review" and check.notified
    note = Notification.objects.get(user=alice)
    assert note.kind == "thesis_check" and note.link == "/stocks/005930"
    assert note.title == "삼성전자 펀더멘털 점검: 확인할 항목이 생겼어요"
    assert note.body.splitlines() == ["영업이익률(TTM) -2.0% (영업이익률이 음수)", "유동비율 70.0%", "종합: 확인 필요",
                                      "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다"]
    assert forbidden_phrases(note.title + note.body) == []  # 매도 권유 없음
    assert OutboxMessage.objects.count() == 0  # 웹만


def test_same_bad_again_does_not_notify_but_worse_overall_does(fake, dart, alice):
    thesis = long_thesis(alice, baseline=BASELINE)
    dart.funds["005930"] = fund(**{"reported.currentRatio": 0.7})
    fake.today = MONDAY
    theses.tick(kst(MONDAY, 18, 0), Log())
    assert Notification.objects.count() == 1
    next_monday = MONDAY + timedelta(days=7)
    fake.today = next_monday
    cache.clear()
    theses.tick(kst(next_monday, 18, 0), Log())  # 같은 bad, 같은 종합 → 알리지 않는다
    second = thesis.checks.order_by("-checked_at").first()
    assert second.new_bad == [] and second.previous_overall == "review" and not second.notified
    assert Notification.objects.count() == 1


def test_overall_getting_worse_without_new_bad_notifies(fake, dart, alice):
    thesis = long_thesis(alice, baseline=BASELINE)
    fake.today = MONDAY
    theses.tick(kst(MONDAY, 18, 0), Log())
    assert thesis.checks.get().overall == "solid" and Notification.objects.count() == 0
    dart.funds["005930"] = fund(**{"reported.currentRatio": 0.9, "nonOperating.financeCosts": 10})  # warn 둘
    later = MONDAY + timedelta(days=7)
    fake.today = later
    cache.clear()
    theses.tick(kst(later, 18, 0), Log())
    check = thesis.checks.order_by("-checked_at").first()
    assert check.overall == "caution" and check.new_bad == [] and check.notified
    note = Notification.objects.get()
    assert note.title == "삼성전자 펀더멘털 점검: 종합 판정이 바뀌었어요"
    assert note.body.splitlines()[-2] == "종합: 기준 충족 → 주의"


def test_two_reports_in_a_row_use_the_previous_report_facts(fake, dart, alice):
    thesis = long_thesis(alice, baseline=BASELINE)
    dart.funds["005930"] = fund(**{"interim.revenue": 97, "report.label": "2026 1분기보고서"})  # −3%: warn
    fake.today = MONDAY
    theses.tick(kst(MONDAY, 18, 0), Log())
    first = thesis.checks.get()
    assert next(r for r in first.rows if r["key"] == "revenueGrowth")["status"] == "warn"
    dart.funds["005930"] = fund(**{"interim.revenue": 98})  # 다음 보고서(반기)도 −2%
    later = MONDAY + timedelta(days=7)
    fake.today = later
    cache.clear()
    theses.tick(kst(later, 18, 0), Log())
    second = thesis.checks.order_by("-checked_at").first()
    row = next(r for r in second.rows if r["key"] == "revenueGrowth")
    assert row["status"] == "bad" and row["note"] == "2개 보고서 연속 감소"
    assert second.new_bad == ["revenueGrowth"] and second.notified


def test_thesis_notice_text_has_no_persuasion():
    rows = fc.evaluate(fund(**{"interim.operatingIncome": -3}), baseline=BASELINE)["rows"]
    from longterm import text
    title, body = text.thesis_notice("삼성전자", rows, ["operatingIncomeGrowth"], "review", "solid")
    assert forbidden_phrases(title + body) == []
    assert "영업이익 성장 자료 없음 (적자 전환)" in body and "종합: 기준 충족 → 확인 필요" in body
