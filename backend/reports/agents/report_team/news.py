"""뉴스·심리 Worker `news_agent` (docs/tasks/02-worker.md T2-6).

자료: Google 뉴스 RSS 제목(`paper_engine.data.news.fetch_news`, 최근 7일)과 증권사 목표주가 헤드라인
(`broker_reports.stock_reports`, 최근 30일). 키가 필요 없고, 받지 못하면 "자료 없음"으로 LLM을 그대로 부른다 (선택 Worker).
블로그·개인 콘텐츠 출처는 fetch_news가 빼고, 여기서도 출처 이름으로 한 번 더 뺀다 (`is_blocked_source`).
제목·매체 이름은 모두 `guards.clean_text`를 거쳐 넣고, 지운 사유가 있으면 결과에 `_guarded`를 붙인다.
headlines는 받은 제목에 있는 것만 남기고(날짜·매체·제목은 자료 값), 자료가 하나도 없으면 sentiment는 neutral·score는 null이다.
"""
from datetime import datetime
from zoneinfo import ZoneInfo

from paper_engine.data import broker_reports
from paper_engine.data.news import LOCALE, fetch_news, is_blocked_source

from ...autohealing import healing
from ...guardrails.guards import clean_text, merge_reasons
from ..base import WorkerContext
from ..prompts import NO_DATA, system_prompt, user_prompt

KST = ZoneInfo("Asia/Seoul")

NEWS_DAYS, NEWS_LIMIT = 7, 10
REPORT_DAYS, REPORT_LIMIT = 30, 10
TITLE_MAX = 300          # 제목·매체 이름 하나의 길이 상한
MAX_HEADLINES = 5        # NewsResult.headlines 상한
MAX_EVIDENCE = 8
MIN_MATCH = 6            # 제목 일부로 맞출 때 짧은 쪽 제목의 최소 글자 수 (공백 뺀)
FETCH_SEC = 15           # 뉴스 검색 한 번의 제한 시간 (엔진 fetch_news의 timeout)
LLM_RESERVE_SEC = 100    # 단계 제한 시간 중 LLM 호출(재시도·대체 모델 포함)에 남겨 둘 시간
NO_SOURCE = "이 시장은 뉴스 검색을 지원하지 않아요"
NEWS_FAILED = "뉴스를 받지 못했어요"
NO_NEWS = "최근 뉴스가 없어요"
NO_REPORTS = "최근 증권사 목표주가 헤드라인이 없어요"
TOO_SLOW = "시간이 모자라 뉴스를 받지 않았어요"

ROLE = ("너는 모의투자 서비스 '모매매'의 AI 리포트 팀에서 뉴스·심리를 맡은 조사 AI다. "
        "최근 뉴스 제목과 증권사 목표주가 헤드라인으로 호재·악재와 시장 분위기를 정리한다.")
RULES = """- 자료는 기사 제목뿐이다 (본문 없음). 제목에서 확인되는 것만 쓰고 기사 내용을 짐작하지 않는다.
- headlines는 자료에 있는 제목만 최대 5개다. 제목·날짜·매체는 자료 그대로 옮기고, impact에는 호재·악재·중립과 짧은 이유를 쓴다.
- sentiment는 전체 분위기(positive·negative·neutral), score는 -1(매우 부정)~1(매우 긍정)이다. 자료가 없으면 neutral·null.
- 증권사 목표주가는 그 증권사의 의견일 뿐이다. 있으면 summary에 그렇게 밝힌다.
- 매수·매도 의견은 내지 않는다 (의견은 작성 AI가 낸다).
- evidence에는 근거가 된 기사 제목과 매체·날짜를 적는다."""


class NewsAgent:
    id = "news_agent"
    output_contract = "NewsResult"

    def run(self, ctx: WorkerContext) -> dict:
        data = gather(ctx)
        prompt = user_prompt({
            "종목": {"symbol": ctx.symbol, "name": ctx.name, "market": ctx.market},
            f"뉴스 제목 (최근 {NEWS_DAYS}일, 최신순)": data["news"] or f"{NO_DATA} ({data['newsNote']})",
            f"증권사 목표주가 헤드라인 (최근 {REPORT_DAYS}일)": data["reports"] or f"{NO_DATA} ({data['reportsNote']})",
        })
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), prompt, contract=self.output_contract)
        return finish(reply.data, data)


def gather(ctx: WorkerContext) -> dict:
    """정리한 뉴스·헤드라인 목록과 없을 때의 이유, 거른 사유(guarded). 실패는 이유로만 남긴다."""
    data = {"news": [], "reports": [], "newsNote": None, "reportsNote": None, "guarded": []}
    reasons: list[list[str]] = []
    if ctx.market not in LOCALE:
        data["newsNote"] = data["reportsNote"] = NO_SOURCE
        return data
    if _time_left(ctx) - LLM_RESERVE_SEC < FETCH_SEC:
        data["newsNote"] = data["reportsNote"] = TOO_SLOW
        return data
    try:
        raw = fetch_news(f'"{ctx.name}"', ctx.market, days=NEWS_DAYS, limit=NEWS_LIMIT)
    except Exception:  # 네트워크·RSS 오류. 뉴스는 선택 자료다
        raw, data["newsNote"] = [], NEWS_FAILED
    data["news"] = _clean([{"date": _day(h.get("publishedAt")), "source": h.get("source"), "title": h.get("title")}
                           for h in raw], reasons)
    data["newsNote"] = data["newsNote"] or (None if data["news"] else NO_NEWS)
    if _time_left(ctx) - LLM_RESERVE_SEC < FETCH_SEC:
        data["reportsNote"] = TOO_SLOW
    else:  # stock_reports는 오류를 삼키고 []를 준다
        found = broker_reports.stock_reports(ctx.name, ctx.symbol, ctx.market, days=REPORT_DAYS,
                                             limit=REPORT_LIMIT, fetch=fetch_news)
        data["reports"] = _clean([{"date": _day(h.get("publishedAt")), "source": h.get("source"),
                                   "title": h.get("title"), "broker": h.get("broker"),
                                   "targetPrice": h.get("targetPrice"), "direction": h.get("direction")}
                                  for h in found], reasons)
        data["reportsNote"] = None if data["reports"] else NO_REPORTS
    data["guarded"] = merge_reasons(*reasons)
    return data


def finish(answer: dict, data: dict) -> dict:
    """headlines를 받은 제목에 있는 것만으로(날짜·매체·제목은 자료 값), 자료가 없으면 neutral·null, evidence 앞에 출처."""
    result = dict(answer)
    known = data["news"] + data["reports"]
    result["headlines"] = match_headlines(result.get("headlines") or [], known)
    if not known:
        result["sentiment"], result["score"] = "neutral", None
    source = [f"뉴스 제목 {len(data['news'])}건 (Google 뉴스, 최근 {NEWS_DAYS}일)" if data["news"]
              else f"뉴스 없음: {data['newsNote']}"]
    if data["reports"]:
        source.append(f"증권사 목표주가 헤드라인 {len(data['reports'])}건 (최근 {REPORT_DAYS}일)")
    result["evidence"] = [*source, *[e for e in result.get("evidence") or [] if e not in source]][:MAX_EVIDENCE]
    if data["guarded"]:
        result["_guarded"] = data["guarded"]
    return result


def match_headlines(items: list[dict], known: list[dict]) -> list[dict]:
    """LLM이 고른 헤드라인 중 자료에 있는 것만 (같은 제목, 또는 한쪽 제목이 다른 쪽을 품을 때). 날짜·매체·제목은 자료 값."""
    out, used = [], set()
    for item in items:
        title = _squash(item.get("title"))
        for index, row in enumerate(known):
            row_title = _squash(row["title"])
            if index not in used and title and (title == row_title or _contains(title, row_title)):
                used.add(index)
                out.append({"date": row["date"], "title": row["title"], "source": row["source"],
                            "impact": item["impact"]})
                break
    return out[:MAX_HEADLINES]


def _clean(rows: list[dict], reasons: list[list[str]]) -> list[dict]:
    """제목·매체·증권사 이름을 clean_text로 거른다 (지운 사유는 reasons에). 제목이 비거나 블로그 출처면 뺀다."""
    out = []
    for row in rows:
        if is_blocked_source(row.get("source")):
            continue
        title, why = clean_text(row.get("title"), TITLE_MAX)
        reasons.append(why)
        if not title.strip():
            continue
        cleaned = {**row, "title": title.strip()}
        for key in ("source", "broker"):
            if key in row:
                text, why = clean_text(row.get(key), TITLE_MAX)
                reasons.append(why)
                cleaned[key] = text.strip() or None
        out.append(cleaned)
    return out


def _contains(a: str, b: str) -> bool:
    short, long = sorted((a, b), key=len)
    return len(short) >= MIN_MATCH and short in long


def _time_left(ctx: WorkerContext) -> float:
    return ctx.deadline - healing.clock()


def _day(value) -> str | None:
    return kst_day(value)


def kst_day(value) -> str | None:
    """기사 시각(ISO, RSS는 GMT) → KST 날짜 "YYYY-MM-DD". 한국 아침 9시 전 기사가 전날로 찍히지 않게. 시간대가 없으면 앞 10자."""
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return value[:10]
    return moment.astimezone(KST).date().isoformat() if moment.tzinfo else value[:10]


def _squash(text) -> str:
    return "".join(str(text or "").split())
