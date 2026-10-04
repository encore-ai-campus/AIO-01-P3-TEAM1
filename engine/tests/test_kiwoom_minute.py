"""키움 분봉 minute_candles (ka10080, docs/API.md "단타 연습").

응답 형식은 **가정(실측 전)**이다: 키움 공식 명세(ka10080)의 필드 이름(stk_min_pole_chart_qry, cur_prc·open_pric·high_pric·low_pric
부호 포함, trde_qty, acc_trde_qty, cntr_tm YYYYMMDDHHmmss)과 일봉(ka10081) 응답 모양을 따라 만든 픽스처다.
실제 응답으로 확인하면 이 픽스처와 _kr_minute_candle을 고친다.
"""
from datetime import datetime

import pytest

from paper_engine.data.kiwoom import (KST, MINUTE_MAX_PAGES, MINUTE_STEPS, KiwoomApiError, bucket_minutes,
                                      minute_session)
from test_kiwoom import make

DAY = "2026-10-01"


def row(stamp: str, close: int, volume: int = 10, **extra) -> dict:
    """ka10080 한 행 (가정(실측 전)). stamp는 YYYYMMDDHHmmss, 가격에는 일봉처럼 방향 부호가 붙는다."""
    return {"cur_prc": f"-{close}", "trde_qty": f"{volume}", "acc_trde_qty": "999999", "cntr_tm": stamp,
            "open_pric": f"+{close - 10}", "high_pric": f"+{close + 20}", "low_pric": f"-{close - 30}",
            "pred_pre": "-100", "pred_pre_sig": "5", **extra}


def minute_pages(pages, more_forever=False):
    """ka10080 페이지 목록 → 연속 조회 헤더(cont-yn·next-key)를 붙여 돌려주는 경로 (최신 → 과거 순서, 가정)."""
    def route(body, headers):
        index = int(headers.get("next-key") or 0)
        more = more_forever or index + 1 < len(pages)
        res_headers = {"cont-yn": "Y", "next-key": str(index + 1)} if more else {"cont-yn": "N", "next-key": ""}
        page = pages[min(index, len(pages) - 1)]
        return 200, {"stk_cd": body["stk_cd"], "stk_min_pole_chart_qry": page, "return_code": 0,
                     "return_msg": "정상적으로 처리되었습니다"}, res_headers
    return route


def calls(http):
    return [c for c in http.calls if c["api"] == "ka10080"]


def test_minute_candles_request_and_conversion():
    page = [row("20261001161000", 70500),          # KRX 애프터마켓 (정규장 밖) → 버린다
            row("20261001153000", 70400, 900),     # 장 마감 단일가 봉 (15:30) → 남긴다
            row("20261001090100", 70100, 20),
            row("20261001090000", 70000, 30),
            row("20260930153000", 69000)]          # 앞 거래일 → 세션 시작까지 받았다
    c, http = make({"ka10080": minute_pages([page])})
    candles, complete = c.minute_candles("005930", DAY)
    assert complete is True
    assert candles == [
        {"timestamp": "2026-10-01T09:00:00+09:00", "openPrice": "69990", "highPrice": "70020",
         "lowPrice": "69970", "closePrice": "70000", "volume": "30"},
        {"timestamp": "2026-10-01T09:01:00+09:00", "openPrice": "70090", "highPrice": "70120",
         "lowPrice": "70070", "closePrice": "70100", "volume": "20"},
        {"timestamp": "2026-10-01T15:30:00+09:00", "openPrice": "70390", "highPrice": "70420",
         "lowPrice": "70370", "closePrice": "70400", "volume": "900"}]
    (call,) = calls(http)
    assert call["url"] == "https://api.kiwoom.com/api/dostk/chart"
    assert call["body"] == {"stk_cd": "005930", "tic_scope": "1", "upd_stkpc_tp": "1", "base_dt": "20261001"}
    assert "cont-yn" not in call["headers"]


def test_minute_candles_follow_continuation_until_session_start():
    pages = [[row("20261001153000", 70400), row("20261001152000", 70300)],
             [row("20261001100000", 70200), row("20261001090000", 70000)],
             [row("20260930151900", 69000)],
             [row("20260929151900", 68000)]]       # 세션 시작 앞까지 닿으면 더 묻지 않는다
    c, http = make({"ka10080": minute_pages(pages)})
    candles, complete = c.minute_candles("005930", DAY, 10)
    assert complete is True
    assert [x["timestamp"][11:16] for x in candles] == ["09:00", "10:00", "15:20", "15:30"]
    sent = calls(http)
    assert len(sent) == 3
    assert [x["headers"].get("next-key") for x in sent] == [None, "1", "2"]
    assert all(x["body"]["tic_scope"] == "10" and x["body"]["base_dt"] == "20261001" for x in sent)


def test_minute_candles_skip_later_days_when_base_date_is_ignored():
    """base_dt를 무시하고 최신부터 주더라도 뒤 날짜 봉은 버리고 계속 넘긴다."""
    pages = [[row("20261002100000", 71000)], [row("20261001150000", 70500)], [row("20260930150000", 69000)]]
    c, _ = make({"ka10080": minute_pages(pages)})
    candles, complete = c.minute_candles("005930", DAY)
    assert complete is True and [x["closePrice"] for x in candles] == ["70500"]


def test_minute_candles_stop_at_page_limit_as_partial():
    c, http = make({"ka10080": minute_pages([[row("20261001150000", 70500)]], more_forever=True)})
    candles, complete = c.minute_candles("005930", DAY)
    assert complete is False and len(calls(http)) == MINUTE_MAX_PAGES == 20
    assert [x["timestamp"] for x in candles] == ["2026-10-01T15:00:00+09:00"]  # 같은 봉은 한 번만


def test_minute_candles_partial_when_kiwoom_has_no_older_bars():
    c, _ = make({"ka10080": minute_pages([[row("20261001150000", 70500), row("20261001140000", 70400)]])})
    candles, complete = c.minute_candles("005930", DAY)
    assert complete is False and len(candles) == 2


def test_minute_candles_read_old_time_format_and_skip_unreadable_rows():
    """옛 형식(cntr_tm HHmmss + cntr_dt)도 읽는다. 시각·종가를 읽을 수 없는 행은 버린다 (가정(실측 전))."""
    page = [{"cur_prc": "70100", "trde_qty": "5", "cntr_tm": "093000", "cntr_dt": "20261001"},  # 시가 등 없음 → 종가
            {"cur_prc": "70000", "trde_qty": "5", "cntr_tm": "093000"},                        # 날짜 없음
            {"cur_prc": "", "cntr_tm": "20261001093100"},                                      # 종가 없음
            {"cur_prc": "70000", "cntr_tm": "2026-10-01"},                                     # 시각 형식 오류
            "not-a-row",
            row("20261001250000", 70000),                                                      # 없는 시각
            row("20260930153000", 69000, volume=0)]
    c, _ = make({"ka10080": minute_pages([page])})
    candles, complete = c.minute_candles("005930", DAY)
    assert complete is True
    assert candles == [{"timestamp": "2026-10-01T09:30:00+09:00", "openPrice": "70100", "highPrice": "70100",
                        "lowPrice": "70100", "closePrice": "70100", "volume": "5"}]


def test_minute_candles_holiday_returns_empty_complete_session():
    c, _ = make({"ka10080": minute_pages([[row("20261002100000", 71000), row("20260930153000", 69000)]])})
    assert c.minute_candles("005930", "2026-10-01") == ([], True)


def test_minute_candles_refuse_us_symbols_and_bad_arguments():
    c, http = make({})
    with pytest.raises(KiwoomApiError, match="국내 종목만"):
        c.minute_candles("AAPL", DAY)
    for minutes in (0, 2, 120, True):
        with pytest.raises(ValueError, match="분봉 간격"):
            c.minute_candles("005930", DAY, minutes)
    for day in ("20261001", "2026-13-01", "", None):
        with pytest.raises(ValueError):
            c.minute_candles("005930", day)
    assert calls(http) == []


def test_minute_session_and_steps():
    start, end = minute_session("2026-10-01", 5)
    assert (start.isoformat(), end.isoformat()) == ("2026-10-01T09:00:00+09:00", "2026-10-01T15:30:00+09:00")
    assert MINUTE_STEPS == (1, 3, 5, 10, 15, 30, 45, 60)


def test_bucket_minutes_groups_from_session_start():
    start = datetime(2026, 10, 1, 9, 0, tzinfo=KST)
    ones = [{"timestamp": f"2026-10-01T09:0{m}:00+09:00", "openPrice": str(100 + m), "highPrice": str(110 + m),
             "lowPrice": str(90 - m), "closePrice": str(105 + m), "volume": "10"} for m in (0, 1, 2, 4, 5, 7)]
    assert bucket_minutes(ones, 1, start) is ones
    assert bucket_minutes(ones, 5, start) == [
        {"timestamp": "2026-10-01T09:00:00+09:00", "openPrice": "100", "highPrice": "114", "lowPrice": "86",
         "closePrice": "109", "volume": "40"},
        {"timestamp": "2026-10-01T09:05:00+09:00", "openPrice": "105", "highPrice": "117", "lowPrice": "83",
         "closePrice": "112", "volume": "20"}]
    assert bucket_minutes([], 30, start) == []
