from datetime import date

from paper_engine.llm import LlmTimeout
from paper_engine.notify import format_research
from paper_engine.agents.researcher import clean, research_context, run_research

TODAY = date(2026, 9, 29)
SNAPSHOT = {
    "symbol": "000660", "name": "SK하이닉스", "market": "KOSPI", "currency": "KRW",
    "lastPrice": 1_756_000.0, "indicators": {"change5d": 0.01, "change20d": -0.1, "change60d": -0.3,
                                             "rsi14": 50},
    "fundamentals": {"ratios": {"per": 7.64}, "nonOperating": {"financeIncome": 82.9}},
    "news": [{"title": "목표주가 하향"}], "recentCandles": [{"close": 1}],
}


def finding(**kw):
    base = {"topic": "실적", "claim": "2분기 영업이익 60.5조원", "date": "2026-07-29",
            "direction": "POSITIVE", "sourceTitle": "뉴스룸", "sourceUrl": "https://a.com/1"}
    return {**base, **kw}


def test_context_is_compact():
    ctx = research_context(SNAPSHOT)
    assert ctx["recentNewsTitles"] == ["목표주가 하향"]
    assert ctx["ratios"] == {"per": 7.64}
    assert "recentCandles" not in ctx and "rsi14" not in ctx["priceChange"]


def test_clean_verifies_sources_against_citations():
    raw = {"findings": [finding(), finding(sourceUrl="https://made-up.com/x")]}
    out = clean(raw, {"https://a.com/1"}, TODAY)
    assert [f["sourceVerified"] for f in out["findings"]] == [True, False]
    # 인용 목록을 주지 않는 모델은 확인할 수 없다
    assert clean(raw, set(), TODAY)["findings"][0]["sourceVerified"] is None


def test_clean_sanitizes_text_and_fields():
    raw = {"findings": [
        finding(claim="평가이익 반영 [chosun.com](https://redirect/abc) 자세히는 https://x.com/y 참고",
                direction="BULLISH", date="2027-01-01",
                sourceUrl="https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA"),
        finding(claim="  "),
        finding(claim="가" * 500, sourceUrl="javascript:alert(1)", date="어제"),
    ]}
    a, b = clean(raw, set(), TODAY)["findings"]
    assert a["claim"] == "평가이익 반영 chosun.com 자세히는 참고"
    assert a["direction"] == "NEUTRAL"
    assert a["date"] is None  # 미래 날짜
    assert a["sourceUrl"] is None  # 중계 주소
    assert len(b["claim"]) == 300 and b["sourceUrl"] is None and b["date"] is None


def test_clean_limits_counts_and_keeps_future_events_only():
    raw = {"findings": [finding(claim=f"사실 {i}") for i in range(20)],
           "upcomingEvents": [{"date": "2026-10-29", "event": "3분기 실적 발표"},
                              {"date": "2026-07-29", "event": "지난 일정"},
                              {"date": "미정", "event": "날짜 없는 일정"}]}
    out = clean(raw, set(), TODAY)
    assert len(out["findings"]) == 8
    assert out["upcomingEvents"] == [{"date": "2026-10-29", "event": "3분기 실적 발표"}]


def test_clean_handles_empty_response():
    assert clean({}, set(), TODAY) == {"findings": [], "upcomingEvents": []}


class FakeLlm:
    def __init__(self, responses):
        self.responses = responses
        self.prompts = []

    def research_json(self, model, system, user, timeout=None):
        self.prompts.append(user)
        out = self.responses[model]
        if isinstance(out, Exception):
            raise out
        return out


def test_run_research_anonymizes_and_survives_failures():
    llm = FakeLlm({
        "m-claude": ({"findings": [finding()]},
                     [{"type": "url_citation", "url_citation": {"url": "https://a.com/1"}}]),
        "m-openai": LlmTimeout("150초 안에 응답 없음"),
        "m-google": ({"findings": [finding(claim="키옥시아 평가이익")]}, []),
    })
    models = ["m-claude", "m-openai", "m-google"]
    research, log = run_research(llm, models, SNAPSHOT, TODAY)

    assert [r["id"] for r in research["researchers"]] == ["R1", "R2"]
    assert log["researchers"] == {"R1": "m-claude", "R2": "m-google"}
    assert any("m-openai" in e for e in log["errors"])
    assert log["timedOut"] == ["m-openai"]
    assert research["researchers"][0]["findings"][0]["sourceVerified"] is True
    assert research["researchers"][1]["findings"][0]["sourceVerified"] is None
    # 스냅샷에 들어가는 내용에는 모델 이름이 없다
    assert not any(name in str(research) for name in models)
    assert "2026-09-29" in llm.prompts[0]

    text = format_research(research, log)
    assert "[R2 m-google] 1건" in text and "키옥시아 평가이익" in text
