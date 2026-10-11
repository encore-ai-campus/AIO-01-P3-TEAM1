"""후보 뉴스 점검 Worker `news_screen_agent` → CandidateNewsResult (docs/design/AI_AGENT_WORKFLOW.md 2장).

후보마다 최근 NEWS_DAYS일 뉴스 제목(Google 뉴스 RSS, 본문 없음)을 모아 LLM 한 번에 준다. 제목·매체는 guards.clean_text를 거친다.
LLM은 후보마다 재료·악재·테마를 낸다. 선정 Guard가 "같은 테마 2개까지"를 테마 이름으로 세므로 같은 테마는 같은 글자로 쓰게 한다.
코드가 고치는 것: 후보 표 밖 종목은 버린다. 뉴스를 받지 못한 후보의 재료·악재·근거는 비우고 neutral로 둔다 (자료 없이 쓴 주장).
"""
from paper_engine.data.news import LOCALE, fetch_news, is_blocked_source

from ...guardrails import guards
from ..base import WorkerContext
from ..report_team.news import kst_day
from ..prompts import NO_DATA, system_prompt, user_prompt
from .team import candidates_of, gather, market_of

NEWS_DAYS, NEWS_LIMIT = 3, 5
TITLE_MAX, SOURCE_MAX = 200, 60
NO_NEWS = "최근 뉴스 없음"

ROLE = """너는 매매 후보 종목의 최근 뉴스를 점검하는 애널리스트다.
후보마다 뉴스 제목에서 재료(주가에 긍정적일 수 있는 사건)와 악재를 찾아 정리하고, 후보들을 테마로 묶는다."""

RULES = f"""- 후보 목록에 있는 종목만, 후보마다 items 하나를 쓴다. symbol은 후보 목록의 코드를 그대로 쓴다.
- materials·concerns·evidence는 그 후보의 뉴스 제목에 있는 내용만 쓴다. evidence는 "날짜 매체 제목" 꼴로 짧게.
- 뉴스가 "{NO_DATA}"이거나 "{NO_NEWS}"인 후보는 sentiment neutral, materials·concerns·evidence는 빈 목록으로 둔다.
- theme은 2~10자의 짧은 테마 이름이다 (예: 반도체, 2차전지, 조선, 방산, 바이오, 원전, 자동차).
  같은 테마는 모든 후보에서 반드시 같은 글자로 쓴다 ("반도체"와 "반도체주"처럼 다르게 쓰지 않는다). 판단이 어려우면 null.
- summary는 후보 전체의 뉴스 흐름을 2~3문장으로 쓴다."""


class NewsScreenAgent:
    id = "news_screen_agent"
    output_contract = "CandidateNewsResult"

    def run(self, ctx: WorkerContext) -> dict:
        rows = candidates_of(ctx)
        country = market_of(ctx)
        country = country if country in LOCALE else "KR"
        guarded: list[list[str]] = []

        def fetch(row: dict) -> list[dict]:
            query = f'"{row.get("name") or row["symbol"]}"'
            return _headlines(fetch_news(query, country, days=NEWS_DAYS, limit=NEWS_LIMIT), guarded)

        news = gather(ctx, rows, fetch)
        listing = [{"symbol": row["symbol"], "name": row.get("name"), "news": news[row["symbol"]] or NO_NEWS}
                   for row in rows]
        user = user_prompt({f"후보별 뉴스 제목 (최근 {NEWS_DAYS}일, 후보마다 최대 {NEWS_LIMIT}개)": listing})
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), user, contract=self.output_contract)
        result = settle(reply.data, rows, news)
        reasons = guards.merge_reasons(*guarded)
        return (result | {"_guarded": reasons}) if reasons else result


def _headlines(items: list[dict], guarded: list[list[str]]) -> list[dict]:
    """뉴스 항목 → [{date, source, title}] (제목·매체는 clean_text를 거친 것, 빈 제목·블로그 출처는 뺀다). 지운 사유는 guarded에 모은다."""
    out = []
    for item in items or []:
        if is_blocked_source(item.get("source")):
            continue
        title, why_title = guards.clean_text(item.get("title"), TITLE_MAX)
        source, why_source = guards.clean_text(item.get("source"), SOURCE_MAX)
        guarded += [why_title, why_source]
        if title.strip():
            out.append({"date": kst_day(item.get("publishedAt")), "source": source or None,
                        "title": title})
    return out


def settle(data: dict, rows: list[dict], news: dict[str, object]) -> dict:
    """계약을 통과한 LLM 결과를 코드로 정리: 후보 밖 종목은 버리고, 뉴스가 없던 후보의 주장은 비운다."""
    symbols = {row["symbol"] for row in rows}
    items = []
    for item in data["items"]:
        if item["symbol"] not in symbols:
            continue
        if not isinstance(news.get(item["symbol"]), list) or not news[item["symbol"]]:
            item = item | {"sentiment": "neutral", "materials": [], "concerns": [], "evidence": []}
        items.append(item)
    return {"summary": data["summary"], "items": items}
