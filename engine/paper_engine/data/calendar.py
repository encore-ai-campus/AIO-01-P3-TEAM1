"""장 운영 정보 (장 달력). 키움 REST API에는 토스 같은 장 달력 API가 없어 코드로 만든다.

반환 형식은 토스 장 운영 정보 API와 같다. scheduler.regular_sessions / trading_sessions와 drop_incomplete가 이 형식을 읽는다.

  {"previousBusinessDay": {...}, "today": {...}, "nextBusinessDay": {...}}

  각 날짜 항목 (시각은 UTC 오프셋이 붙은 ISO 문자열):
    국내(KR): {"date": "YYYY-MM-DD", "integrated": {"preMarket": 구간, "regularMarket": 구간, "afterMarket": 구간}}
    미국(US): {"date": "YYYY-MM-DD", "preMarket": 구간, "regularMarket": 구간, "afterMarket": 구간}
    구간: {"startTime": "2026-09-29T09:00:00+09:00", "endTime": "2026-09-29T15:30:00+09:00"}
  previousBusinessDay·nextBusinessDay는 오늘 기준 직전·다음 영업일이다. 오늘이 휴장이면 today의 구간은 None이다
  (국내는 "integrated": None, 미국은 "regularMarket": None 등).

  국내(Asia/Seoul): KRX 정규장 09:00~15:30 (장 마감 단일가 15:20~15:30). 시간외는 KRX+NXT(넥스트레이드) 합집합으로 넓게 잡는다 —
    preMarket 08:00~08:50 (NXT 프리마켓), afterMarket 15:30~20:00 (KRX+NXT 합집합).
    2026-09-14 개편: KRX 시간외단일가 폐지, KRX 애프터마켓 16:00~20:00 신설, NXT 애프터마켓 15:40~20:00
    (그 전 KRX 장후 시간외는 15:40~18:00). afterMarket은 둘을 묶은 15:30~20:00 그대로 둔다 — 정규장 밖 판단에만 쓴다.
    휴장: 주말, 공휴일(data.go.kr 한국천문연구원 특일정보 getRestDeInfo: 공휴일·대체공휴일·임시공휴일·선거일),
    양력 고정 공휴일(신정·삼일절·어린이날·현충일·광복절·개천절·한글날·성탄절), 근로자의날(5/1),
    KRX 연말 휴장일(12월 마지막 영업일).
    KRX 특별 운영일 (정규장 시각이 바뀌는 날, KR_SPECIAL_REGULAR): 수능일(KR_CSAT_DAYS) 10:00~16:30, 새해 첫 거래일 10:00~15:30.
      시간외 구간은 preMarket 그대로, afterMarket은 정규장 종료부터 20:00 (정규장 밖 판단에만 쓴다).
      수능일은 교육부가 해마다 정한다 — 새 수능일을 KR_CSAT_DAYS에 더한다.
    미반영: 임시 휴장(시장 사정), 장애로 인한 장 마감 연장 같은 그날 공지 (백엔드는 현지 17:00 전 오늘 종가를 굳은 값으로 보지 않는다).
  미국(America/New_York): 정규장 09:30~16:00, preMarket 04:00~09:30, afterMarket 16:00~20:00. 서머타임은 zoneinfo.
    NYSE 휴장: 신정, 마틴 루터 킹 데이, 대통령의 날, 성금요일, 메모리얼 데이, 준틴스, 독립기념일, 노동절, 추수감사절,
    성탄절 (토요일이면 금요일, 일요일이면 월요일에 쉰다. 단 신정이 토요일이면 전년 12/31은 쉬지 않는다).
    조기 폐장 13:00 (애프터마켓 13:00~17:00): 독립기념일 전날·크리스마스 이브(평일이고 휴장이 아닐 때), 추수감사절 다음 날.
    미반영: 국가 애도일 같은 임시 휴장.

장마감 기준 (docs/API.md 공통 규칙 "장마감 기준", docs/DECISIONS.md 14-1): 화면의 가격은 직전 정규장 종가다.
  close_basis_day  기준일 = 정규장 종료 + CLOSE_SETTLE_MIN(10분)이 지금 이전인 가장 최근 영업일 (시장 현지 날짜)
  close_of         일봉 중 날짜가 기준일 이하인 마지막 봉의 종가와 그 앞 봉의 종가
  session_end_iso  그 날짜의 정규장 종료 시각 (asOf). 장 달력에 없으면 기본 시각 (KR 15:30, US 뉴욕 16:00·조기 폐장 13:00)
"""
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
NEW_YORK = ZoneInfo("America/New_York")
HOLIDAY_URL = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo"
HOLIDAY_CACHE_DAYS = 7      # 디스크 캐시가 이보다 오래되면 다시 받는다 (임시공휴일은 연중에 추가된다)
MEMORY_TTL_SEC = 6 * 3600   # 메모리에 둔 공휴일을 다시 확인하는 간격
FALLBACK_TTL_SEC = 3600     # 조회에 실패했을 때 다시 시도하는 간격
KR_FIXED_HOLIDAYS = ((1, 1), (3, 1), (5, 1), (5, 5), (6, 6), (8, 15), (10, 3), (10, 9), (12, 25))  # 5/1은 근로자의날

# (시작, 끝) 현지 시각. KR은 integrated 아래에 둔다.
KR_SESSIONS = {"preMarket": ("08:00", "08:50"), "regularMarket": ("09:00", "15:30"), "afterMarket": ("15:30", "20:00")}
US_SESSIONS = {"preMarket": ("04:00", "09:30"), "regularMarket": ("09:30", "16:00"), "afterMarket": ("16:00", "20:00")}
US_EARLY_CLOSE = {"preMarket": ("04:00", "09:30"), "regularMarket": ("09:30", "13:00"), "afterMarket": ("13:00", "17:00")}
# KRX 특별 운영일 정규장 (시작, 끝) 현지 시각 (KRX 공지). 수능일은 1시간 늦게 열고 늦게 닫는다.
KR_CSAT_DAYS = frozenset({date(2024, 11, 14), date(2025, 11, 13), date(2026, 11, 19)})  # 대학수학능력시험일
KR_SPECIAL_REGULAR = {"csat": ("10:00", "16:30"), "newYear": ("10:00", "15:30")}       # 수능일, 새해 첫 거래일(개장일)
CLOSE_SETTLE_MIN = 10  # 정규장 종료 뒤 일봉 종가가 굳기를 기다리는 여유 (분)
CALENDAR_DAYS = ("previousBusinessDay", "today", "nextBusinessDay")


def _regular(entry: dict | None) -> dict | None:
    """날짜 항목의 정규장 구간 (국내는 integrated 아래, 해외는 바로 아래). 휴장이거나 없으면 None."""
    if not entry:
        return None
    session = entry.get("integrated") or entry
    regular = session.get("regularMarket")
    return regular if isinstance(regular, dict) and regular.get("endTime") else None


def close_basis_day(calendar: dict, market_country: str, now: datetime,
                    settle_minutes: int = CLOSE_SETTLE_MIN) -> str | None:
    """장마감 기준일 "YYYY-MM-DD" (그 시장 현지 날짜): 정규장 종료 + settle_minutes가 now 이전인 가장 최근 영업일.

    오늘(장 달력 today)이 영업일이고 그 시각이 지났으면 오늘, 아니면 직전 영업일(previousBusinessDay).
    직전 영업일 항목에 정규장 구간이 없으면 그 날짜를 그대로 쓴다 (직전 영업일은 정의상 영업일이다).
    장 달력에 둘 다 없으면 None. now에는 시간대가 있어야 한다.
    """
    if market_country not in ("KR", "US"):
        raise ValueError(f"지원하지 않는 시장: {market_country}")
    settle = timedelta(minutes=settle_minutes)
    for key in ("today", "previousBusinessDay"):
        entry = calendar.get(key) or {}
        day = entry.get("date")
        if not day:
            continue
        regular = _regular(entry)
        if regular is None:
            if key == "previousBusinessDay":
                return day
            continue  # 오늘이 휴장
        if datetime.fromisoformat(regular["endTime"]) + settle <= now:
            return day
    return None


def session_end_iso(calendar: dict, market_country: str, day: str) -> str:
    """day(YYYY-MM-DD, 시장 현지 날짜)의 정규장 종료 시각 ISO (오프셋 포함).

    장 달력(전일·당일·익일)에 그 날짜의 정규장이 있으면 그 endTime, 없으면 기본 시각:
    KR 15:30+09:00, US 뉴욕 16:00 (NYSE 조기 폐장일이면 13:00, 서머타임 반영).
    """
    if market_country not in ("KR", "US"):
        raise ValueError(f"지원하지 않는 시장: {market_country}")
    for key in CALENDAR_DAYS:
        entry = calendar.get(key) or {}
        regular = _regular(entry)
        if entry.get("date") == day and regular is not None:
            return regular["endTime"]
    d = date.fromisoformat(day)
    if market_country == "KR":
        hhmm, tz = KR_SESSIONS["regularMarket"][1], KST
    else:
        table = US_EARLY_CLOSE if d in us_early_closes(d.year) else US_SESSIONS
        hhmm, tz = table["regularMarket"][1], NEW_YORK
    h, m = map(int, hhmm.split(":"))
    return datetime(d.year, d.month, d.day, h, m, tzinfo=tz).isoformat()


def close_of(candles: list[dict], day: str) -> dict | None:
    """일봉(과거 → 최신) 중 날짜(timestamp 앞 10자)가 day 이하인 마지막 봉의 종가.

    {"close": float, "prevClose": float | None, "date": "YYYY-MM-DD"}. prevClose는 그 앞 봉의 종가 (앞 봉이 없으면 None).
    해당하는 봉이 없으면 None.
    """
    done = [c for c in candles if c["timestamp"][:10] <= day]
    if not done:
        return None
    last = done[-1]
    prev = float(done[-2]["closePrice"]) if len(done) > 1 else None
    return {"close": float(last["closePrice"]), "prevClose": prev, "date": last["timestamp"][:10]}


def drop_incomplete(candles: list[dict], calendar: dict, now: datetime) -> list[dict]:
    """오늘자 봉이 정규장 마감 전이면 제외한다. 봉의 날짜는 장 운영 정보의 date와 같은 기준이다.

    오늘이 휴장이거나(정규장 구간이 없음) 장 운영 정보가 없으면 봉을 그대로 둔다.
    """
    today = calendar.get("today")
    if not candles or not today:
        return candles
    session = today.get("integrated") or today  # 국내는 integrated 아래, 해외는 바로 아래
    regular = session.get("regularMarket")
    if not regular:
        return candles
    close = datetime.fromisoformat(regular["endTime"])
    if candles[-1]["timestamp"][:10] == today.get("date") and now < close:
        return candles[:-1]
    return candles


class MarketCalendar:
    """시장별 장 운영 정보를 만든다. KiwoomClient.market_calendar가 쓴다.

    data_gokr_api_key가 없으면 국내 음력·대체·임시 공휴일을 모른다 (주말과 양력 고정 공휴일, 근로자의날, KRX 연말 휴장만
    반영하고 경고를 한 번 남긴다). 공휴일 조회 결과는 cache_dir/holidays-KR-<연도>.json에 캐시한다.
    여러 스레드가 같은 객체를 써도 된다.
    """

    def __init__(self, data_gokr_api_key: str | None = None, cache_dir=None):
        self._key = data_gokr_api_key
        self._cache_dir = Path(cache_dir) if cache_dir else None
        self._lock = threading.Lock()
        self._years: dict[int, tuple[frozenset[date], float]] = {}  # 연도 → (공휴일, 다시 확인할 monotonic 시각)
        self._warned = False
        self._urlopen = urllib.request.urlopen  # 테스트에서 가짜 전송으로 바꾼다
        self._monotonic = time.monotonic

    def calendar(self, market_country: str, now: datetime | None = None) -> dict:
        """market_country(KR | US)의 장 운영 정보. now가 없으면 지금 (시장 현지 날짜 기준으로 today를 정한다)."""
        if market_country not in ("KR", "US"):
            raise ValueError(f"지원하지 않는 시장: {market_country}")
        tz = KST if market_country == "KR" else NEW_YORK
        now = now or datetime.now(timezone.utc)
        if now.tzinfo is None:
            raise ValueError("now에는 시간대가 있어야 한다")
        today = now.astimezone(tz).date()
        return {
            "previousBusinessDay": self._entry(market_country, self._step(market_country, today, -1)),
            "today": self._entry(market_country, today),
            "nextBusinessDay": self._entry(market_country, self._step(market_country, today, 1)),
        }

    def is_business_day(self, market_country: str, day: date) -> bool:
        if day.weekday() >= 5:
            return False
        if market_country == "KR":
            return day not in self._kr_closed(day.year)
        return day not in us_holidays(day.year)

    # --- 날짜 항목 ---

    def _step(self, market_country: str, day: date, direction: int) -> date:
        day += timedelta(days=direction)
        while not self.is_business_day(market_country, day):
            day += timedelta(days=direction)
        return day

    def _entry(self, market_country: str, day: date) -> dict:
        is_open = self.is_business_day(market_country, day)
        if market_country == "KR":
            return {"date": day.isoformat(), "integrated": _sessions(day, self._kr_table(day), KST) if is_open else None}
        if not is_open:
            return {"date": day.isoformat(), **{name: None for name in US_SESSIONS}}
        table = US_EARLY_CLOSE if day in us_early_closes(day.year) else US_SESSIONS
        return {"date": day.isoformat(), **_sessions(day, table, NEW_YORK)}

    def _kr_table(self, day: date) -> dict:
        """국내 영업일 day의 구간 표. 수능일·새해 첫 거래일은 정규장 시각이 바뀐다 (KR_SPECIAL_REGULAR)."""
        if day in KR_CSAT_DAYS:
            regular = KR_SPECIAL_REGULAR["csat"]
        elif day == self._step("KR", date(day.year, 1, 1), 1):  # 1월 1일(신정) 다음 첫 영업일
            regular = KR_SPECIAL_REGULAR["newYear"]
        else:
            return KR_SESSIONS
        return {**KR_SESSIONS, "regularMarket": regular, "afterMarket": (regular[1], KR_SESSIONS["afterMarket"][1])}

    # --- 국내 휴장일 ---

    def _kr_closed(self, year: int) -> frozenset[date]:
        """주말을 뺀 국내 휴장일 (공휴일 + 근로자의날 + KRX 연말 휴장일)."""
        holidays = self._kr_holidays(year)
        last = date(year, 12, 31)
        while last.weekday() >= 5 or last in holidays:
            last -= timedelta(days=1)
        return holidays | {last}

    def _kr_holidays(self, year: int) -> frozenset[date]:
        with self._lock:
            cached = self._years.get(year)
            if cached and self._monotonic() < cached[1]:
                return cached[0]
            fixed = {date(year, m, d) for m, d in KR_FIXED_HOLIDAYS}
            fetched = self._fetch_or_cache(year)
            ttl = MEMORY_TTL_SEC if fetched is not None else FALLBACK_TTL_SEC
            holidays = frozenset(fixed | (fetched or set()))
            self._years[year] = (holidays, self._monotonic() + ttl)
            return holidays

    def _fetch_or_cache(self, year: int) -> set[date] | None:
        """특일정보 공휴일. 디스크 캐시 → API → 오래된 디스크 캐시 순서. 모두 실패하면 None (경고 한 번)."""
        path = self._cache_dir / f"holidays-KR-{year}.json" if self._cache_dir else None
        stale = None
        if path and path.exists():
            try:
                data = json.loads(path.read_text())
                stale = {date.fromisoformat(d) for d in data["dates"]}
                fetched_at = datetime.fromisoformat(data["fetchedAt"])
                if datetime.now(timezone.utc) - fetched_at < timedelta(days=HOLIDAY_CACHE_DAYS):
                    return stale
            except (ValueError, KeyError, TypeError):
                stale = None
        error = "DATA_GOKR_API 키 없음"
        if self._key:
            try:
                dates = self._fetch_holidays(year)
            except (OSError, ValueError, KeyError, TypeError) as e:  # urllib 오류는 OSError의 하위 클래스다
                error = f"{type(e).__name__}: {e}"
            else:
                if path:
                    self._write_cache(path, dates)
                return dates
        if stale is not None:
            return stale
        if not self._warned:
            self._warned = True
            print(f"국내 공휴일을 받지 못해 주말·양력 고정 공휴일·근로자의날·연말 휴장만 반영함 ({error})", flush=True)
        return None

    def _fetch_holidays(self, year: int) -> set[date]:
        query = urllib.parse.urlencode({
            "serviceKey": urllib.parse.unquote(self._key), "solYear": year,
            "numOfRows": 100, "pageNo": 1, "_type": "json"})
        with self._urlopen(f"{HOLIDAY_URL}?{query}", timeout=10) as res:
            data = json.loads(res.read())  # 키 오류는 XML로 오므로 여기서 ValueError가 난다
        response = data["response"]
        code = response["header"]["resultCode"]
        if code != "00":
            raise ValueError(f"특일정보 오류 {code}: {response['header'].get('resultMsg')}")
        items = (response["body"].get("items") or {}).get("item") or []
        if isinstance(items, dict):  # 결과가 하나면 리스트가 아니라 객체로 온다
            items = [items]
        dates = set()
        for item in items:
            if item.get("isHoliday", "Y") == "Y":
                text = str(item["locdate"])
                dates.add(date(int(text[:4]), int(text[4:6]), int(text[6:8])))
        return dates

    @staticmethod
    def _write_cache(path: Path, dates: set[date]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".tmp{os.getpid()}")
        tmp.write_text(json.dumps({"fetchedAt": datetime.now(timezone.utc).isoformat(),
                                   "dates": sorted(d.isoformat() for d in dates)}))
        os.replace(tmp, path)


# --- 미국 (NYSE) ---

def us_holidays(year: int) -> frozenset[date]:
    """NYSE 휴장일 (대체 휴일 반영)."""
    days = {
        _nth_weekday(year, 1, 0, 3),               # 마틴 루터 킹 데이: 1월 셋째 월요일
        _nth_weekday(year, 2, 0, 3),               # 대통령의 날: 2월 셋째 월요일
        _easter(year) - timedelta(days=2),         # 성금요일
        _last_weekday(year, 5, 0),                 # 메모리얼 데이: 5월 마지막 월요일
        _observed(date(year, 7, 4)),               # 독립기념일
        _nth_weekday(year, 9, 0, 1),               # 노동절: 9월 첫째 월요일
        _nth_weekday(year, 11, 3, 4),              # 추수감사절: 11월 넷째 목요일
        _observed(date(year, 12, 25)),             # 성탄절
    }
    new_year = date(year, 1, 1)
    if new_year.weekday() != 5:  # 토요일이면 전년 12/31에 쉬지 않는다 (NYSE 규칙)
        days.add(_observed(new_year))
    if year >= 2022:
        days.add(_observed(date(year, 6, 19)))     # 준틴스
    return frozenset(days)


def us_early_closes(year: int) -> frozenset[date]:
    """NYSE 13:00 조기 폐장일."""
    holidays = us_holidays(year)
    days = {_nth_weekday(year, 11, 3, 4) + timedelta(days=1)}  # 추수감사절 다음 날
    for candidate in (date(year, 7, 3), date(year, 12, 24)):
        if candidate.weekday() < 5 and candidate not in holidays:
            days.add(candidate)
    return frozenset(days)


def _observed(day: date) -> date:
    if day.weekday() == 5:
        return day - timedelta(days=1)
    if day.weekday() == 6:
        return day + timedelta(days=1)
    return day


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last = date(year + month // 12, month % 12 + 1, 1) - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _easter(year: int) -> date:
    """그레고리력 부활절 (Anonymous Gregorian algorithm)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l_ = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_) // 451
    month, day = divmod(h + l_ - 7 * m + 114, 31)
    return date(year, month, day + 1)


def _sessions(day: date, table: dict, tz: ZoneInfo) -> dict:
    def at(hhmm: str) -> str:
        h, m = map(int, hhmm.split(":"))
        return datetime(day.year, day.month, day.day, h, m, tzinfo=tz).isoformat()
    return {name: {"startTime": at(start), "endTime": at(end)} for name, (start, end) in table.items()}
