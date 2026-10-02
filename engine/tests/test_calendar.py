from datetime import datetime

from paper_engine.data.calendar import drop_incomplete

CANDLES = [{"timestamp": "2026-09-28T00:00:00.000+09:00"}, {"timestamp": "2026-09-29T00:00:00.000+09:00"}]
KR = {"today": {"date": "2026-09-29", "integrated": {"regularMarket": {
    "endTime": "2026-09-29T15:30:00.000+09:00"}}}}
US = {"today": {"date": "2026-09-29", "regularMarket": {"endTime": "2026-09-30T05:00:00.000+09:00"}}}


def at(text):
    return datetime.fromisoformat(text)


def test_drops_todays_candle_before_close():
    assert drop_incomplete(CANDLES, KR, at("2026-09-29T12:00:00+09:00")) == CANDLES[:1]
    assert drop_incomplete(CANDLES, US, at("2026-09-30T04:59:00+09:00")) == CANDLES[:1]


def test_keeps_candle_after_close():
    assert drop_incomplete(CANDLES, KR, at("2026-09-29T15:30:00+09:00")) == CANDLES
    assert drop_incomplete(CANDLES, US, at("2026-09-30T05:00:00+09:00")) == CANDLES


def test_keeps_candles_when_last_is_not_today():
    assert drop_incomplete(CANDLES[:1], KR, at("2026-09-29T12:00:00+09:00")) == CANDLES[:1]


def test_handles_missing_data():
    assert drop_incomplete([], KR, at("2026-09-29T12:00:00+09:00")) == []
    assert drop_incomplete(CANDLES, {"today": None}, at("2026-09-29T12:00:00+09:00")) == CANDLES


def test_keeps_candles_when_today_is_holiday():
    holiday = {"today": {"date": "2026-09-29", "integrated": None}}
    assert drop_incomplete(CANDLES, holiday, at("2026-09-29T12:00:00+09:00")) == CANDLES
    us_holiday = {"today": {"date": "2026-09-29", "regularMarket": None}}
    assert drop_incomplete(CANDLES, us_holiday, at("2026-09-29T12:00:00+09:00")) == CANDLES


# --- MarketCalendar ---

import io  # noqa: E402
import json  # noqa: E402
import urllib.parse  # noqa: E402
from datetime import date, timezone  # noqa: E402

import pytest  # noqa: E402

from paper_engine.data.calendar import MarketCalendar, us_early_closes, us_holidays  # noqa: E402
from paper_engine.scheduler import regular_sessions, trading_sessions  # noqa: E402

# 특일정보 getRestDeInfo 응답 형식 (2026년 공휴일: 설·추석 연휴, 대체공휴일, 지방선거일)
HOLIDAYS = {
    2026: [(20260101, "1월1일"), (20260216, "설날"), (20260217, "설날"), (20260218, "설날"), (20260301, "삼일절"),
           (20260302, "대체공휴일"), (20260505, "어린이날"), (20260524, "부처님오신날"), (20260525, "대체공휴일"),
           (20260603, "전국동시지방선거"), (20260606, "현충일"), (20260815, "광복절"), (20260817, "대체공휴일"),
           (20260924, "추석"), (20260925, "추석"), (20260926, "추석"), (20260928, "대체공휴일"),
           (20261003, "개천절"), (20261005, "대체공휴일"), (20261009, "한글날"), (20261225, "기독탄신일")],
    2027: [(20270101, "1월1일")],
}


class HolidayApi:
    def __init__(self, holidays=HOLIDAYS):
        self.holidays, self.urls = holidays, []

    def __call__(self, url, timeout):
        self.urls.append(url)
        year = int(urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["solYear"][0])
        items = [{"dateKind": "01", "dateName": n, "isHoliday": "Y", "locdate": d, "seq": 1}
                 for d, n in self.holidays.get(year, [])]
        item = items[0] if len(items) == 1 else items  # 결과가 하나면 객체로 온다
        body = {"response": {"header": {"resultCode": "00", "resultMsg": "NORMAL SERVICE."},
                             "body": {"items": {"item": item} if items else "", "numOfRows": 100, "pageNo": 1,
                                      "totalCount": len(items)}}}
        return io.BytesIO(json.dumps(body).encode())


def kr_calendar(tmp_path=None, api=None):
    c = MarketCalendar("key%2Bwith%3Dencoding", tmp_path)
    c._urlopen = api or HolidayApi()
    return c


def kst(text):
    return datetime.fromisoformat(f"{text}+09:00")


def test_kr_regular_day_format():
    cal = kr_calendar().calendar("KR", kst("2026-09-22T12:00:00"))
    assert cal["today"] == {"date": "2026-09-22", "integrated": {
        "preMarket": {"startTime": "2026-09-22T08:00:00+09:00", "endTime": "2026-09-22T08:50:00+09:00"},
        "regularMarket": {"startTime": "2026-09-22T09:00:00+09:00", "endTime": "2026-09-22T15:30:00+09:00"},
        "afterMarket": {"startTime": "2026-09-22T15:30:00+09:00", "endTime": "2026-09-22T20:00:00+09:00"}}}
    assert cal["previousBusinessDay"]["date"] == "2026-09-21"
    assert cal["nextBusinessDay"]["date"] == "2026-09-23"


def test_kr_chuseok_and_substitute_holiday():
    c = kr_calendar()
    cal = c.calendar("KR", kst("2026-09-23T10:00:00"))
    assert cal["nextBusinessDay"]["date"] == "2026-09-29"  # 24~26 추석, 27 일요일, 28 대체공휴일
    holiday = c.calendar("KR", kst("2026-09-24T10:00:00"))
    assert holiday["today"] == {"date": "2026-09-24", "integrated": None}
    assert holiday["previousBusinessDay"]["date"] == "2026-09-23"
    assert holiday["nextBusinessDay"]["date"] == "2026-09-29"


def test_kr_seollal_and_other_substitutes():
    c = kr_calendar()
    assert c.calendar("KR", kst("2026-02-13T10:00:00"))["nextBusinessDay"]["date"] == "2026-02-19"
    assert c.calendar("KR", kst("2026-10-02T10:00:00"))["nextBusinessDay"]["date"] == "2026-10-06"  # 개천절 대체
    assert c.calendar("KR", kst("2026-02-27T10:00:00"))["nextBusinessDay"]["date"] == "2026-03-03"  # 삼일절 대체
    assert not c.is_business_day("KR", date(2026, 6, 3))  # 지방선거일 (임시공휴일)


def test_kr_labor_day_is_closed_even_if_not_in_api():
    c = kr_calendar()
    cal = c.calendar("KR", kst("2026-04-30T10:00:00"))
    assert cal["nextBusinessDay"]["date"] == "2026-05-04"


def test_kr_year_end_closing():
    c = kr_calendar()
    assert not c.is_business_day("KR", date(2026, 12, 31))  # 목요일이지만 연말 휴장
    cal = c.calendar("KR", kst("2026-12-30T10:00:00"))
    assert cal["nextBusinessDay"]["date"] == "2027-01-04"  # 12/31 휴장, 1/1 신정, 주말
    assert c.calendar("KR", kst("2027-01-04T10:00:00"))["previousBusinessDay"]["date"] == "2026-12-30"
    # 12/31이 주말이면 그 전 마지막 평일이 휴장 (2028-12-31 일요일 → 12-29 금요일)
    assert not c.is_business_day("KR", date(2028, 12, 29))
    assert c.is_business_day("KR", date(2028, 12, 28))


def test_kr_holidays_are_cached_per_year(tmp_path):
    api = HolidayApi()
    c = kr_calendar(tmp_path, api)
    c.calendar("KR", kst("2026-09-23T10:00:00"))
    c.calendar("KR", kst("2026-09-24T10:00:00"))
    assert len(api.urls) == 1
    query = urllib.parse.parse_qs(urllib.parse.urlparse(api.urls[0]).query)
    assert query["serviceKey"] == ["key+with=encoding"]  # 인코딩된 키를 풀어서 한 번만 인코딩한다
    assert query["_type"] == ["json"]
    saved = json.loads((tmp_path / "holidays-KR-2026.json").read_text())
    assert "2026-09-28" in saved["dates"]

    def offline(url, timeout):
        raise OSError("network down")
    again = kr_calendar(tmp_path, offline)
    assert again.calendar("KR", kst("2026-09-23T10:00:00"))["nextBusinessDay"]["date"] == "2026-09-29"


def test_kr_without_key_warns_once_and_uses_fixed_holidays(capsys):
    c = MarketCalendar()
    c.calendar("KR", kst("2026-09-23T10:00:00"))
    c.calendar("KR", kst("2026-09-30T10:00:00"))
    out = capsys.readouterr().out
    assert out.count("국내 공휴일을 받지 못해") == 1
    assert not c.is_business_day("KR", date(2026, 10, 9))  # 한글날 (양력 고정)
    assert not c.is_business_day("KR", date(2026, 5, 1))   # 근로자의날
    assert c.is_business_day("KR", date(2026, 9, 24))      # 음력 공휴일은 모른다


def test_kr_api_error_falls_back_to_stale_cache(tmp_path, capsys):
    (tmp_path / "holidays-KR-2026.json").write_text(json.dumps(
        {"fetchedAt": "2026-01-01T00:00:00+00:00", "dates": ["2026-09-24", "2026-09-25", "2026-09-28"]}))

    def xml_error(url, timeout):  # 키 오류는 _type=json이어도 XML로 온다
        return io.BytesIO(b"<OpenAPI_ServiceResponse><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR"
                          b"</returnAuthMsg></OpenAPI_ServiceResponse>")
    c = kr_calendar(tmp_path, xml_error)
    assert c.calendar("KR", kst("2026-09-23T10:00:00"))["nextBusinessDay"]["date"] == "2026-09-29"
    assert "국내 공휴일을 받지 못해" not in capsys.readouterr().out


def test_us_daylight_saving_transition():
    c = MarketCalendar()
    cal = c.calendar("US", datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc))  # 금요일 10:00 EST
    assert cal["today"]["regularMarket"] == {"startTime": "2026-03-06T09:30:00-05:00",
                                             "endTime": "2026-03-06T16:00:00-05:00"}
    assert cal["nextBusinessDay"]["date"] == "2026-03-09"
    assert cal["nextBusinessDay"]["regularMarket"]["startTime"] == "2026-03-09T09:30:00-04:00"  # 서머타임 시작
    fall = c.calendar("US", datetime(2026, 11, 2, 15, 0, tzinfo=timezone.utc))
    assert fall["today"]["regularMarket"]["startTime"] == "2026-11-02T09:30:00-05:00"
    assert fall["previousBusinessDay"]["regularMarket"]["startTime"] == "2026-10-30T09:30:00-04:00"


def test_us_today_is_new_york_date():
    cal = MarketCalendar().calendar("US", datetime(2026, 10, 2, 2, 0, tzinfo=timezone.utc))  # 10/1 22:00 EDT
    assert cal["today"]["date"] == "2026-10-01"


def test_us_good_friday_and_holiday_entry():
    c = MarketCalendar()
    cal = c.calendar("US", datetime(2026, 4, 3, 15, 0, tzinfo=timezone.utc))
    assert cal["today"] == {"date": "2026-04-03", "preMarket": None, "regularMarket": None, "afterMarket": None}
    assert cal["previousBusinessDay"]["date"] == "2026-04-02"
    assert cal["nextBusinessDay"]["date"] == "2026-04-06"
    assert date(2025, 4, 18) in us_holidays(2025) and date(2027, 3, 26) in us_holidays(2027)


def test_us_early_closes():
    c = MarketCalendar()
    cal = c.calendar("US", datetime(2026, 11, 27, 15, 0, tzinfo=timezone.utc))
    assert cal["today"]["regularMarket"]["endTime"] == "2026-11-27T13:00:00-05:00"
    assert cal["today"]["afterMarket"] == {"startTime": "2026-11-27T13:00:00-05:00",
                                           "endTime": "2026-11-27T17:00:00-05:00"}
    assert cal["previousBusinessDay"]["date"] == "2026-11-25"  # 추수감사절 휴장
    assert us_early_closes(2026) == {date(2026, 11, 27), date(2026, 12, 24)}  # 7/3은 휴장이라 조기 폐장 없음
    assert us_early_closes(2025) == {date(2025, 7, 3), date(2025, 11, 28), date(2025, 12, 24)}


def test_us_weekend_observed_holidays():
    assert date(2026, 7, 3) in us_holidays(2026)       # 독립기념일 토요일 → 금요일
    assert date(2027, 12, 24) in us_holidays(2027)     # 성탄절 토요일 → 금요일
    assert date(2027, 6, 18) in us_holidays(2027)      # 준틴스 토요일 → 금요일
    assert date(2027, 7, 5) in us_holidays(2027)       # 독립기념일 일요일 → 월요일
    assert date(2028, 1, 1) not in us_holidays(2028)   # 신정 토요일: 쉬지 않고
    assert date(2027, 12, 31) not in us_holidays(2027)  # 전년 12/31도 쉬지 않는다
    assert date(2023, 1, 2) in us_holidays(2023)       # 신정 일요일 → 월요일


def test_calendar_works_with_scheduler_and_drop_incomplete():
    c = kr_calendar()
    cal = c.calendar("KR", kst("2026-09-23T10:00:00"))
    assert regular_sessions(cal) == [
        (kst("2026-09-22T09:00:00"), kst("2026-09-22T15:30:00")),
        (kst("2026-09-23T09:00:00"), kst("2026-09-23T15:30:00")),
        (kst("2026-09-29T09:00:00"), kst("2026-09-29T15:30:00"))]
    assert (kst("2026-09-23T15:30:00"), kst("2026-09-23T20:00:00")) in trading_sessions(cal)
    candles = [{"timestamp": "2026-09-22T00:00:00+09:00"}, {"timestamp": "2026-09-23T00:00:00+09:00"}]
    assert drop_incomplete(candles, cal, kst("2026-09-23T10:00:00")) == candles[:1]
    assert drop_incomplete(candles, cal, kst("2026-09-23T15:30:00")) == candles
    holiday = c.calendar("KR", kst("2026-09-24T10:00:00"))
    assert len(regular_sessions(holiday)) == 2
    us = MarketCalendar().calendar("US", datetime(2026, 4, 3, 15, 0, tzinfo=timezone.utc))
    assert [s.date().isoformat() for s, _ in regular_sessions(us)] == ["2026-04-02", "2026-04-06"]


def test_calendar_rejects_bad_input():
    c = MarketCalendar()
    with pytest.raises(ValueError):
        c.calendar("JP")
    with pytest.raises(ValueError):
        c.calendar("KR", datetime(2026, 9, 23, 10, 0))
