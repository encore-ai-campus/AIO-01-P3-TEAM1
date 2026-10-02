"""증권사 리포트 헤드라인 (Google News RSS, 키 불필요). 리포트 본문은 가져오지 않는다.

뉴스 제목에서 종목·증권사·목표가·방향을 정규식으로 뽑는다. 제목 기반이라 누락과 오류가 있을 수 있다.
네이버 금융(finance.naver.com)은 robots.txt로 자동 수집을 막고 있어 쓰지 않는다.

  - fetch_headlines: 시장별 리포트 검색어로 최근 헤드라인을 모은다 (선별 후보용)
  - parse_headline: 제목 하나에서 {"names", "broker", "targetPrice", "direction"}
  - match: 뽑은 이름을 전체 종목 목록과 정확히 맞춘다. 모호하면 None (모르는 종목을 후보에 넣지 않는다)
  - candidates: 헤드라인 → 파싱 → 매칭 → 종목별 최신 하나
  - stock_reports: 종목 하나의 최근 리포트 헤드라인 (분석 스냅샷의 brokerReports)
"""
import re

from . import news

QUERIES = {"KR": ("목표주가", "리포트 브리핑 목표가"), "US": ("price target raised", "analyst price target")}
DIRECTIONS = ("UP", "DOWN", "KEEP")

# --- 국내 ---
# 증권사 이름 (한 단어): 미래에셋증권, 유진투자, BNK투자, 삼성證, NH투자증권
_KR_BROKER = re.compile(r"[A-Za-z가-힣&]{1,12}?(증권|證券|證|투자)")
_KR_TAG = re.compile(r"^\s*\[[^\]]*\]\s*")  # [리포트 브리핑]
_KR_TAIL = re.compile(r"\s*-\s*([^-]+?)\s*$")  # 끝의 "- 미래에셋증권", "- 머니투데이"
_KR_LEAD = re.compile(r"^(?P<broker>[^\s,:\"“”'‘’]+)\s*[,:]?\s*[\"“”'‘’]?\s*(?=\S)")
_KR_NAME = r"[^\s,\"“”'‘’…·\[\]()<>]+"
_KR_FIRST = re.compile(rf"^(?P<name>{_KR_NAME})\s*(,|\s+목표(주)?가)")
_KR_BEFORE_TARGET = re.compile(rf"(?P<names>{_KR_NAME}(·{_KR_NAME})*)\s*목표(주)?가")
# 목표가 186,000원 · 목표주가 36만원 · 목표주가 6만6000원
_KR_PRICE = re.compile(r"목표(?:주)?가\s*(?:를|는|은)?\s*(?:(?P<man>\d[\d,]*(?:\.\d+)?)\s*만\s*(?P<rest>\d[\d,]*)?"
                       r"|(?P<n>\d[\d,]*(?:\.\d+)?))\s*원")
_KR_DIRECTION = re.compile(r"목표(?:주)?가[^…,\"“”]{0,15}?(상향|하향|유지|↑|↓)")
_KR_DIRECTION_WORDS = {"상향": "UP", "↑": "UP", "하향": "DOWN", "↓": "DOWN", "유지": "KEEP"}
# 이름 자리에 오지만 종목이 아닌 말
_KR_STOPWORDS = {"증권가", "증권사", "증권업계", "리포트", "주가", "목표", "잇단", "잇따라", "외국인", "기관"}

# --- 미국 ---
_US_EXCHANGE = re.compile(r"\(?\b(?:NYSE|NASDAQ|Nasdaq|NasdaqGS|NasdaqGM|NasdaqCM|AMEX|NYSEAMERICAN|NYSEARCA"
                          r"|NYSEAmerican|OTC|BATS)\s*:\s*(?P<ticker>[A-Z][A-Z.\-]{0,6})\)?")
_US_NAME_BEFORE_EXCHANGE = re.compile(r"^(?P<name>[A-Z][\w.&'\-]*(?:\s+[\w.&'\-]+){0,5}?)\s*\((?:NYSE|NASDAQ|Nasdaq"
                                      r"|AMEX|NYSEAMERICAN|NYSEARCA|OTC|BATS)")
_US_FIRST_TICKER = re.compile(r"^(?P<ticker>[A-Z]{1,5})(?=\s|:|'s\b)")
_US_NAME_AFTER_VERB = re.compile(r"\b(?:raise[sd]?|lift(?:s|ed)?|boost(?:s|ed)?|hike[sd]?|cut(?:s)?|lower(?:s|ed)?"
                                 r"|trim(?:s|med)?)\s+(?P<name>[A-Z][\w.&'\-]*(?:\s+[\w.&'\-]+){0,4}?)"
                                 r"(?:'s)?\s+price\s+targets?\b")
_US_BROKER = re.compile(r"\b(?:by|at)\s+(?P<broker>[A-Z][\w&.'\-]*(?:\s+(?:&\s+)?[A-Z][\w&.'\-]*){0,3})")
_US_PRICE = (re.compile(r"target[^$]{0,40}?\bto\s+\$\s*(?P<n>\d[\d,]*(?:\.\d+)?)", re.I),
             re.compile(r"target[^$]{0,20}?\$\s*(?P<n>\d[\d,]*(?:\.\d+)?)", re.I),
             re.compile(r"\$\s*(?P<n>\d[\d,]*(?:\.\d+)?)\s+(?:price\s+)?target", re.I))
_US_UP = re.compile(r"\b(raise[sd]?|lift(s|ed)?|boost(s|ed)?|hike[sd]?|upgrade[sd]?|increase[sd]?|ups)\b", re.I)
_US_DOWN = re.compile(r"\b(lower(s|ed)?|cut(s)?|trim(s|med)?|reduce[sd]?|downgrade[sd]?|slash(es|ed)?)\b", re.I)
_US_KEEP = re.compile(r"\b(maintain(s|ed)?|reiterate[sd]?|keeps|kept|reaffirm(s|ed)?)\b", re.I)
# 문장 첫 대문자 토큰이지만 티커가 아닌 말 (증권사 약칭 포함)
_US_STOPWORDS = {"A", "I", "US", "USA", "AI", "CEO", "IPO", "ETF", "NYSE", "UBS", "BMO", "RBC", "KBW", "BTIG",
                 "HSBC", "TD", "DA", "CFRA", "BNP", "BOFA", "EPS", "Q1", "Q2", "Q3", "Q4", "PT"}
# 영문 이름을 맞출 때 떼는 회사 형태 꼬리
_US_SUFFIX = re.compile(r"(,?\s+(inc|corp|corporation|co|company|ltd|plc|holdings|group)\.?)+$", re.I)


def _number(text: str) -> float | None:
    try:
        return float(text.replace(",", ""))
    except ValueError:
        return None


def _dedupe(items) -> list:
    return list(dict.fromkeys(i for i in items if i))


def _is_kr_broker(word: str) -> bool:
    return bool(_KR_BROKER.fullmatch(word))


def _kr_broker_name(word: str) -> str:
    return word.replace("證券", "증권").replace("證", "증권")


def _parse_kr(title: str) -> dict:
    # "기대...목표주가↓"의 마침표 줄임표도 구분자로 본다
    body, broker = re.sub(r"\.{2,}", "…", " ".join(title.split())), None
    # 끝의 "- 증권사" (그 뒤에 "- 매체"가 붙어 있을 수 있다)
    rest = body
    for _ in range(2):
        m = _KR_TAIL.search(rest)
        if not m:
            break
        if _is_kr_broker(m[1]):
            broker, body = _kr_broker_name(m[1]), rest[:m.start()]
            break
        rest = rest[:m.start()]
    body = _KR_TAG.sub("", body).lstrip("\"“”'‘’ ")
    # 앞의 "증권사 "종목…", "증권사, 종목…", "삼성證 종목,"
    m = _KR_LEAD.match(body)
    if m and _is_kr_broker(m["broker"]):
        broker = broker or _kr_broker_name(m["broker"])
        body = body[m.end():]
    names = []
    if m := _KR_FIRST.match(body):
        names.append(m["name"])
    for m in _KR_BEFORE_TARGET.finditer(body):
        names += m["names"].split("·")
    names = [n for n in _dedupe(names) if n not in _KR_STOPWORDS and not _is_kr_broker(n)]
    target = None
    if m := _KR_PRICE.search(body):
        if m["man"]:
            target = _number(m["man"]) * 10_000 + (_number(m["rest"]) if m["rest"] else 0)
        else:
            target = _number(m["n"])
    direction = None
    if m := _KR_DIRECTION.search(body):
        direction = _KR_DIRECTION_WORDS[m[1]]
    return {"names": names, "broker": broker, "targetPrice": target, "direction": direction}


def _parse_us(title: str) -> dict:
    body = " ".join(title.split())
    names = [m["ticker"] for m in _US_EXCHANGE.finditer(body)]
    if m := _US_NAME_BEFORE_EXCHANGE.match(body):
        names.append(m["name"])
    if (m := _US_FIRST_TICKER.match(body)) and m["ticker"] not in _US_STOPWORDS:
        names.append(m["ticker"])
    if m := _US_NAME_AFTER_VERB.search(body):
        names.append(m["name"])
    target = None
    for pattern in _US_PRICE:
        if m := pattern.search(body):
            target = _number(m["n"])
            break
    up, down = _US_UP.search(body), _US_DOWN.search(body)
    if up and (not down or up.start() < down.start()):
        direction = "UP"
    elif down:
        direction = "DOWN"
    else:
        direction = "KEEP" if _US_KEEP.search(body) else None
    broker = m["broker"] if (m := _US_BROKER.search(body)) else None
    return {"names": _dedupe(names), "broker": broker, "targetPrice": target, "direction": direction}


def parse_headline(title: str, market: str) -> dict:
    """제목 하나에서 종목 이름(후보)·증권사·목표가·방향을 뽑는다. 못 뽑은 값은 비워 둔다 (예외를 내지 않는다)."""
    try:
        return (_parse_kr if market == "KR" else _parse_us)(title or "")
    except Exception:  # 제목 형식이 제각각이라 파싱 실패는 빈 값으로 둔다
        return {"names": [], "broker": None, "targetPrice": None, "direction": None}


def _norm(text) -> str:
    return "".join(str(text or "").split()).upper()


def _norm_english(text) -> str:
    return _norm(_US_SUFFIX.sub("", str(text or "").strip()))


def match(parsed_names: list[str], listed: list[dict]) -> dict | None:
    """이름(또는 미국 티커)이 전체 종목 목록과 정확히 같은 종목 하나. 없거나 여러 종목이면 None.

    공백과 대소문자만 무시한다. 부분 일치는 받지 않는다 (모르는 종목을 후보에 넣지 않는다).
    티커는 영문 종목코드(미국)만 맞춘다.
    """
    wanted = {_norm(n) for n in parsed_names if n}
    english = {_norm_english(n) for n in parsed_names if n}
    found = {}
    for s in listed:
        symbol = _norm(s.get("symbol"))
        if (_norm(s.get("name")) in wanted
                or (s.get("englishName") and _norm_english(s["englishName"]) in english)
                or (symbol.isalpha() and symbol in wanted)):
            found[s["symbol"]] = s
    return next(iter(found.values())) if len(found) == 1 else None


def fetch_headlines(market: str, days: int = 2, limit: int = 40, fetch=news.fetch_news) -> list[dict]:
    """시장별 리포트 검색어의 헤드라인. 제목이 같으면 한 번만, 최신순. 모든 검색이 실패하면 마지막 오류를 낸다."""
    items, errors, ok = {}, [], False
    for query in QUERIES[market]:
        try:
            got = fetch(query, market, days=days, limit=limit)
        except Exception as e:  # 한 검색어가 실패해도 나머지로 만든다
            errors.append(e)
            continue
        ok = True
        for h in got:
            items.setdefault(h["title"], h)
    if not ok and errors:
        raise errors[-1]
    return sorted(items.values(), key=lambda h: h["publishedAt"], reverse=True)


def candidates(market: str, listed: list[dict], days: int = 2, fetch=news.fetch_news) -> list[dict]:
    """최근 리포트 헤드라인에서 종목 목록과 정확히 맞는 종목 → 종목별 최신 헤드라인 하나 (최신순)."""
    out: dict[str, dict] = {}
    for h in fetch_headlines(market, days, fetch=fetch):
        parsed = parse_headline(h["title"], market)
        stock = match(parsed["names"], listed)
        if not stock or stock["symbol"] in out:
            continue
        out[stock["symbol"]] = {"symbol": stock["symbol"], "name": stock["name"], "broker": parsed["broker"],
                                "targetPrice": parsed["targetPrice"], "direction": parsed["direction"],
                                "title": h["title"], "publishedAt": h["publishedAt"], "source": h.get("source")}
    return list(out.values())


def stock_reports(name: str, symbol: str, market: str, days: int = 30, limit: int = 10,
                  fetch=news.fetch_news) -> list[dict]:
    """종목 하나의 최근 리포트 헤드라인 (목표가 언급이 있는 것만, 최신순). 네트워크 오류면 빈 리스트."""
    query = f'"{name}" 목표주가' if market == "KR" else f'"{name}" price target'
    try:
        headlines = fetch(query, market, days=days, limit=limit)
    except Exception:  # 보조 자료라 실패해도 분석은 계속한다
        return []
    keys = {k for k in (_norm(name), _norm(symbol)) if k}
    out = []
    for h in headlines:
        title = h.get("title") or ""
        mentions = any(k in _norm(title) for k in keys)
        about_target = "목표" in title if market == "KR" else "target" in title.lower()
        if not (mentions and about_target):
            continue
        parsed = parse_headline(title, market)
        out.append({"publishedAt": h.get("publishedAt"), "source": h.get("source"), "title": title,
                    "broker": parsed["broker"], "targetPrice": parsed["targetPrice"],
                    "direction": parsed["direction"]})
    return out
