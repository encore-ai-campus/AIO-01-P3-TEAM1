"""키움 REST API 읽기 전용 실측 확인. 키를 받으면 한 번 돌려 docs/KIWOOM.md의 "실측 미확인" 항목을 채운다.

    uv run python scripts/kiwoom_check.py                 # 국내 확인
    uv run python scripts/kiwoom_check.py --us --fx       # 미국 시세·환율까지
    uv run python scripts/kiwoom_check.py --save-raw /tmp/kiwoom-raw   # TR별 원본 응답을 JSON으로 저장

.env(또는 환경 변수)의 KIWOOM_APPKEY, KIWOOM_SECRETKEY, KIWOOM_BASE_URL, KIWOOM_TOKEN_CACHE, DATA_GOKR_API를 쓴다.
조회 TR만 부른다 (계좌·주문 TR 없음). 앱키·시크릿·토큰은 출력하지 않는다. 각 확인은 실패해도 다음으로 넘어간다.
"""
import argparse
import json
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))

from paper_engine.config import ROOT, load_config  # noqa: E402
from paper_engine.data.calendar import MarketCalendar  # noqa: E402
from paper_engine.data.kiwoom import KiwoomApiError, KiwoomClient  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []
CHECKS = []


def check(name: str):
    def wrap(fn):
        def run(*args):
            print(f"\n== {name}", flush=True)
            started = time.monotonic()
            try:
                note = fn(*args) or ""
                RESULTS.append((name, True, note))
                print(f"   OK ({time.monotonic() - started:.1f}s) {note}")
            except KiwoomApiError as e:
                RESULTS.append((name, False, f"KiwoomApiError {e}"))
                print(f"   FAIL KiwoomApiError status={e.status} body={json.dumps(e.body, ensure_ascii=False)[:400]}")
            except Exception as e:  # 실측 스크립트라 어떤 오류든 기록하고 계속한다
                RESULTS.append((name, False, f"{type(e).__name__}: {e}"))
                print(f"   FAIL {type(e).__name__}: {e}")
                traceback.print_exc(limit=3)
        CHECKS.append(run)
        return run
    return wrap


def show(value, limit=1200):
    print("   " + json.dumps(value, ensure_ascii=False, indent=1)[:limit].replace("\n", "\n   "))


class RawRecorder:
    """KiwoomClient._call을 감싸 TR별 원본 응답·연속 조회 헤더를 기록한다 (토큰 발급 응답은 기록하지 않는다)."""

    def __init__(self, client: KiwoomClient, out: Path | None):
        self.out, self.pages = out, {}
        original = client._call

        def call(api_id, body, next_key=None):
            data, next_page = original(api_id, body, next_key)
            self.pages.setdefault(api_id, []).append({"request": body, "next": next_page, "response": data})
            if self.out:
                self.out.mkdir(parents=True, exist_ok=True)
                (self.out / f"{api_id}.json").write_text(json.dumps(self.pages[api_id], ensure_ascii=False, indent=1))
            return data, next_page
        client._call = call

    def last(self, api_id):
        return self.pages.get(api_id, [{}])[-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="005930")
    parser.add_argument("--us", action="store_true", help="미국 시세·일봉·순위도 확인 (MARKETS=US 전에 필요)")
    parser.add_argument("--us-symbol", default="NVDA")
    parser.add_argument("--fx", action="store_true", help="환율 조회 TR(ust31301) 확인")
    parser.add_argument("--save-raw", type=Path, help="TR별 원본 응답을 저장할 폴더 (비밀 값 없음)")
    args = parser.parse_args()

    cfg = load_config(require_broker=False)  # 로컬 .env가 BROKER=toss여도 이 스크립트는 키움만 확인한다
    if not (cfg.kiwoom_appkey and cfg.kiwoom_secretkey):
        raise SystemExit(".env 또는 환경변수에 KIWOOM_APPKEY, KIWOOM_SECRETKEY 값이 없습니다.")
    calendar = MarketCalendar(cfg.data_gokr_api_key, ROOT / ".cache")
    client = KiwoomClient(cfg.kiwoom_appkey, cfg.kiwoom_secretkey, cfg.token_cache, calendar, cfg.kiwoom_base_url)
    raw = RawRecorder(client, args.save_raw)
    sym = args.symbol
    print(f"도메인 {cfg.kiwoom_base_url}, 토큰 캐시 {cfg.token_cache}")

    @check("토큰 발급 (au10001)")
    def token():
        client._access_token()
        left = (client._expires_at - time.time()) / 3600
        return f"만료까지 {left:.1f}시간 (만료 시각 {time.strftime('%Y-%m-%d %H:%M', time.localtime(client._expires_at))})"

    @check(f"현재가 {sym} (ka10095)")
    def prices():
        result = client.prices([sym, "000660"])
        show(result)
        show({k: raw.last("ka10095").get("response", {}).get("atn_stk_infr", [{}])[0].get(k)
              for k in ("cur_prc", "sel_bid", "buy_bid", "cntr_tm", "dt")})
        return f"{len(result)}종목"

    @check(f"호가 {sym} (ka10004)")
    def orderbook():
        book = client.orderbook(sym)
        show({"bids": book["bids"][:3], "asks": book["asks"][:3]})
        return f"매수 {len(book['bids'])}단계, 매도 {len(book['asks'])}단계"

    @check(f"확인 가격 {sym}")
    def confirmed():
        return str(client.confirmed_prices([sym]))

    @check(f"일봉 {sym} (ka10081)")
    def candles():
        result = client.daily_candles(sym, 3)
        show(result)
        page = raw.last("ka10081")
        rows = len(page["response"].get("stk_dt_pole_chart_qry") or [])
        return f"한 페이지 {rows}행, 다음 페이지 키 {'있음' if page['next'] is not None else '없음'}"

    @check(f"일봉 연속 조회 {sym}")
    def candle_pages():
        page, cursor = client.candles_before(sym, None, 1)
        older, _ = client.candles_before(sym, cursor, 1) if cursor else ([], None)
        return f"1쪽 {len(page)}개 ({page[0]['timestamp'][:10]}~), 2쪽 {len(older)}개" + (
            f" ({older[0]['timestamp'][:10]}~{older[-1]['timestamp'][:10]})" if older else "")

    @check("거래대금 상위 KR (ka10032)")
    def amount():
        items, ranked_at = client.rankings_with_time("MARKET_TRADING_AMOUNT", "KR", "1d", count=5)
        show(items)
        page = raw.last("ka10032")
        rows = len(page["response"].get("trde_prica_upper") or [])
        return f"기준 시각 {ranked_at}, 한 페이지 {rows}행, 다음 페이지 {'있음' if page['next'] is not None else '없음'}"

    @check("상승률 상위 KR (ka10027)")
    def gainers():
        show(client.rankings("TOP_GAINERS", "KR", count=3))

    @check("종목정보 리스트 (ka10099 × 13)")
    def directory():
        entries = client._kr_directory()
        kinds = {}
        for e in entries.values():
            kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
        return f"{len(entries)}종목 {kinds}"

    @check("종목 정보 (삼성전자·KODEX 200·KODEX 레버리지)")
    def stocks():
        show(client.stocks([sym, "069500", "122630"]))
        client._call("ka10100", {"stk_cd": "069500"})
        lookup = raw.last("ka10100")["response"]
        return f"ka10100 069500 marketCode={lookup.get('marketCode')} marketName={lookup.get('marketName')}"

    @check(f"매수 유의 {sym}")
    def warnings():
        return str(client.warnings(sym))

    @check(f"투자자별 매매동향 {sym} (ka10059)")
    def investors():
        show(client.investor_trading(sym, 3))

    @check("장 달력 KR")
    def calendar_kr():
        show(client.market_calendar("KR"), 600)

    if args.fx:
        @check("환율 (ust31301)")
        def fx():
            rate = client.exchange_rate()
            show([p["response"] for p in raw.pages.get("ust31301", [])])
            return f"USD/KRW {rate['rate']}"

    if args.us:
        us = args.us_symbol

        @check(f"미국 거래소구분 {us} (usa10098)")
        def us_exchange():
            return client._us_exchange(us)

        @check(f"미국 현재가·호가 {us} (usa20100·usa20101)")
        def us_quotes():
            show(client.prices([us]))
            book = client.orderbook(us)
            show({"bids": book["bids"][:2], "asks": book["asks"][:2]})

        @check(f"미국 일봉 {us} (usa06012)")
        def us_candles():
            result = client.daily_candles(us, 3)
            show(result)
            page = raw.last("usa06012")
            rows = len(page["response"].get("result_list") or [])
            return f"한 페이지 {rows}행, 다음 페이지 {'있음' if page['next'] is not None else '없음'}"

        @check("미국 거래대금 상위 (usa20540)")
        def us_amount():
            show(client.rankings("MARKET_TRADING_AMOUNT", "US", count=3))

        @check("미국 종목 정보")
        def us_stocks():
            show(client.stocks([us, "SPY"]))

        @check("장 달력 US")
        def calendar_us():
            show(client.market_calendar("US"), 600)

    for run in CHECKS:
        run()

    print("\n== 요약")
    for name, ok, note in RESULTS:
        print(f"{'OK  ' if ok else 'FAIL'} {name}  {note}")
    return 0 if all(ok for _, ok, _ in RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
