"""운영 E2E 점검 UX-4·UX-5 (docs/records/운영E2E점검_UX리뷰_2026-10-08.md): 쉬운 글 전문 용어 Guard, 리포트 결과 후처리, 뉴스 출처.

- 쉬운 글(plainSummary·oneLiner·reasons·risks)에 전문 용어 → 검토가 RETRY(사유에 걸린 용어). 한도를 다 쓴 마지막 검토는 통과하고,
  State에는 괄호 풀이를 붙인 글이 남는다.
- State에 넣기 전 후처리: "201000원" → "201,000원", 한국어 문장 속 hold·buy… → 지켜보기·매수…
- 블로그·개인 콘텐츠 출처는 뉴스 근거에서 뺀다.
실제 LLM·증권사·뉴스는 부르지 않는다 (가짜 호출기·FakeLlm·monkeypatch).
"""
import copy

import pytest
from paper_engine.wording import forbidden_phrases
from trading import market as quotes_module

from config import engine
from reports.guardrails import contracts, guards, tidy
from reports.autohealing import healing
from reports.orchestration import orchestrator, registry
from reports.agents.report_team import news, report, review
from reports.agents.selection_team import news_screen
from reports.agents.base import WorkerContext
from reports.models import Report

from ..conftest import SAMPLES, FakeLlm, FakeWorker, fake_team, make_report

PASS = SAMPLES["ReviewResult"]
JARGON_DRAFT = {
    **SAMPLES["ReportDraft"], "verdict": "hold",
    "oneLiner": "AI 의견은 hold예요. 이동평균선 아래라 지켜봐요",
    "plainSummary": ["주가가 이동평균선 아래에 있어요", "실적은 안정적이에요", "AI 의견은 지켜보기예요"],
    "reasons": ["PER 13.9배 · RSI 32.2", "지지선 187900원 근처"],
    "risks": ["지지선 187900원 아래로 이탈하면 의견을 다시 봐야 해요"],
    "markdown": "## AI 의견과 가격 제안\nAI 의견은 **hold**예요. 목표 가격 201000원은 제시하지 않아요.\nStrong Buy rating",
    "targets": {"entry": None, "target": None, "stop": None, "holdingDays": None, "probability": None},
    "citations": ["일봉 201000원"],
}
PLAIN_DRAFT = {
    **JARGON_DRAFT, "oneLiner": "AI 의견은 지켜보기예요",
    "plainSummary": ["주가가 최근 평균 가격 아래에 있어요", "실적은 안정적이에요", "AI 의견은 지켜보기예요"],
    "reasons": ["번 돈에 비해 주가가 낮은 편이에요"], "risks": ["그동안 버텨 온 187,900원 아래로 내려가면 다시 봐야 해요"],
}


class FakeCaller:
    """ctx.llm 자리: 대본의 답을 차례로 (계약 검증까지). prompts에 (system, user)를 남긴다."""

    def __init__(self, *answers):
        self.answers, self.prompts, self.calls, self.cost_usd = list(answers), [], [], 0.0

    def __call__(self, system, user, *, contract=None, timeout=None):
        self.prompts.append((system, user))
        data = contracts.validate(contract, self.answers.pop(0))
        return healing.LlmReply(data=data, provider="devpass", model="fake", attempts=1, recovered=False,
                                latency_ms=1, recovery_ms=None, cost_usd=0.0)


def context(worker_id, llm, *, inputs=None, attempt=1, market="KR", deadline=None) -> WorkerContext:
    return WorkerContext(report_id=1, task_id="report-1", symbol="005930", name="삼성전자", market=market,
                         worker_id=worker_id, attempt=attempt, inputs=inputs or {}, instructions=None, handoff=None,
                         llm=llm, deadline=deadline or healing.clock() + 180, cfg=None, client=None)


@pytest.fixture
def no_warnings(monkeypatch):
    monkeypatch.setattr(quotes_module, "warnings", lambda symbol: [])


# ---------------------------------------------------------------------- 후처리 함수

@pytest.mark.parametrize("text, expected", [
    ("목표 가격 201000원의 근거", "목표 가격 201,000원의 근거"),
    ("현재 75300 원", "현재 75,300 원"),
    ("가격 12345678원", "가격 12,345,678원"),
    ("1,234,567원 · 999원 · 201000.5원 · 1000만원 · 100억원 · 2026년", "1,234,567원 · 999원 · 201000.5원 · 1000만원 · 100억원 · 2026년"),
])
def test_won_amounts_get_thousands_commas(text, expected):
    assert tidy.won_commas(text) == expected


@pytest.mark.parametrize("text, expected", [
    ("AI 의견은 **hold**예요", "AI 의견은 **지켜보기**예요"),
    ("**hold** 의견이므로 목표 가격은 제시하지 않아요", "**지켜보기** 의견이므로 목표 가격은 제시하지 않아요"),
    ("AI 의견은 BUY", "AI 의견은 매수"),
    ("의견: Watch.", "의견: 지켜보기."),
    ("AI 의견은 avoid예요", "AI 의견은 부정적이에요"),            # 받침 있는 말로 바뀌면 조사도
    ("avoid로 바뀌었고 sell이 아니에요", "부정적으로 바뀌었고 매도가 아니에요"),
    ("hold이고 buy가 아니에요", "지켜보기이고 매수가 아니에요"),     # "이고"의 "이"는 조사가 아니다
    ("증권사 의견 Strong Buy 유지", "증권사 의견 Strong Buy 유지"),  # 영어 문구 속 낱말은 그대로
    ("의견 표기(buy/hold/avoid)", "의견 표기(buy/hold/avoid)"),
    ("AI 의견은 매수(buy)예요", "AI 의견은 매수(buy)예요"),          # 괄호 풀이는 그대로
    ("verdict: hold", "verdict: hold"),                              # 한글이 없는 줄은 그대로
    ("holder·household·sellers", "holder·household·sellers"),
])
def test_opinion_english_in_korean_sentences_becomes_korean(text, expected):
    assert tidy.korean_opinions(text) == expected


def test_jargon_terms_skip_plain_words():
    assert tidy.jargon_terms("20일선과 60일선 아래, RSI 32.2, PER 13.9배") == ["이동평균선", "RSI", "PER"]
    assert tidy.jargon_terms("이평선·지지선·저항선 돌파와 지지선 이탈, 등락률·MACD·PBR·ROE·밸류에이션·모멘텀·변동성·컨센서스·턴어라운드") == [
        "이동평균선", "지지선", "저항선", "이탈", "돌파", "등락률", "MACD", "PBR", "ROE", "밸류에이션", "모멘텀", "변동성",
        "컨센서스", "턴어라운드"]
    assert tidy.jargon_terms("돌파구를 찾는 중이에요. 이탈리아 수출, 3일 선물 만기, PERIOD, 슈퍼에서") == []


def test_explain_jargon_adds_plain_words_once_within_limit():
    assert tidy.explain_jargon("주가는 이동평균선 아래, 이동평균선이 내려가요") == (
        "주가는 이동평균선(최근 며칠 동안의 평균 가격) 아래, 이동평균선이 내려가요")
    assert tidy.explain_jargon("PER(주가수익비율) 13.9배") == "PER(주가수익비율) 13.9배"  # 이미 풀이가 있으면 그대로
    text = "가" * 70 + " RSI"
    assert tidy.explain_jargon(text, limit=80) == text                                      # 넘게 되면 붙이지 않는다
    assert tidy.explain_jargon(text, limit=None).endswith("RSI(최근 오른 폭과 내린 폭을 비교한 점수)")


def test_explanations_are_plain_words():
    """풀이에는 숫자(plainSummary 숫자 금지)·용어 표의 말·권유 표현이 없다."""
    for name, _, plain in tidy.JARGON:
        assert not any(c.isdigit() for c in plain), name
        assert tidy.jargon_terms(plain) == [], name
        assert forbidden_phrases(plain) == [], name


def test_tidy_report_draft_fields():
    result = tidy.tidy_result("ReportDraft", copy.deepcopy(JARGON_DRAFT))

    assert result["verdict"] == "hold" and result["citations"] == ["일봉 201000원"]  # 값 필드·인용은 그대로
    assert result["oneLiner"] == "AI 의견은 지켜보기예요. 이동평균선(최근 며칠 동안의 평균 가격) 아래라 지켜봐요"
    assert result["plainSummary"][0] == "주가가 이동평균선(최근 며칠 동안의 평균 가격) 아래에 있어요"
    assert result["reasons"] == ["PER(회사가 버는 돈에 비해 주가가 몇 배인지) 13.9배 · RSI(최근 오른 폭과 내린 폭을 비교한 점수) 32.2",
                                 "지지선(그동안 더 내려가지 않고 버텨 온 가격대) 187,900원 근처"]
    assert result["risks"] == ["지지선(그동안 더 내려가지 않고 버텨 온 가격대) 187,900원 아래로 "
                               "이탈(정해 둔 가격대를 벗어남)하면 의견을 다시 봐야 해요"]
    # 본문(전문가 글)은 용어 풀이 없이 금액·영어만
    assert result["markdown"] == ("## AI 의견과 가격 제안\nAI 의견은 **지켜보기**예요. 목표 가격 201,000원은 제시하지 않아요.\n"
                                  "Strong Buy rating")
    assert contracts.validate("ReportDraft", result) == result       # 후처리 뒤에도 계약 그대로
    assert tidy.tidy_result("ReportDraft", result) == result         # 두 번 해도 같다


def test_tidy_keeps_contract_length_limits():
    one_liner = "AI 의견은 지켜보기예요 " + "가" * 60 + " RSI"     # 80자 안. 풀이를 붙이면 넘는다
    result = tidy.tidy_result("ReportDraft", {**JARGON_DRAFT, "oneLiner": one_liner})
    assert result["oneLiner"] == one_liner and len(one_liner) <= contracts.ONE_LINER_MAX


def test_tidy_research_summaries_and_other_contracts():
    market = tidy.tidy_result("MarketResult", {**SAMPLES["MarketResult"], "summary": "종가 201000원, 의견 hold로 봤다"})
    assert market["summary"] == "종가 201,000원, 의견 지켜보기로 봤다" and market["signals"] == SAMPLES["MarketResult"]["signals"]
    review_result = {**PASS, "instructions": "목표가 77000원"}
    assert tidy.tidy_result("ReviewResult", review_result) == review_result  # 검토 지적(초안 인용)은 그대로


# ---------------------------------------------------------------------- 쉬운 글 Guard · 검토

def test_easy_jargon_issue_per_field_with_terms():
    issues = guards.easy_jargon(JARGON_DRAFT)
    assert [issue["claim"].split(":")[0] for issue in issues] == [
        "한 줄 결론(oneLiner)", "쉬운 요약(plainSummary)", "근거(reasons)", "위험(risks)"]
    assert issues[0]["problem"] == "코드 확인: 한 줄 결론(oneLiner)에 쉬운 글에 쓰지 않는 전문 용어가 있습니다: 이동평균선"
    assert issues[2]["problem"].endswith("RSI, PER, 지지선") and "RSI → '최근 오른 폭과 내린 폭을 비교한 점수'" in issues[2]["fix"]
    assert guards.easy_jargon(PLAIN_DRAFT) == [] and guards.easy_jargon(None) == []
    longest = sorted(tidy.JARGON, key=lambda row: -len(row[2]))[:guards.EXAMPLES_MAX + 1]  # 풀이가 가장 긴 용어들
    many = guards.easy_jargon({"plainSummary": ["·".join(name for name, _, _ in longest)]})
    assert len(many[0]["fix"]) <= contracts.LIST_ITEM_MAX  # 계약이 issue 글을 자르지 않게


def test_review_turns_pass_into_retry_for_jargon(no_warnings):
    llm = FakeCaller(PASS)
    result = review.ReviewAgent().run(context("review_agent", llm, inputs={
        "market_agent": SAMPLES["MarketResult"], "report_agent": JARGON_DRAFT}))
    assert result["verdict"] == "RETRY"
    assert any("이동평균선" in issue["problem"] for issue in result["issues"])
    assert "쉬운 말로 풀어 쓴다" in result["instructions"]
    system, user = llm.prompts[0]
    assert "전문 용어는 코드가 따로 점검한다" in system and "코드 점검 결과" in user and "이동평균선" in user


def test_review_last_round_lets_jargon_pass(no_warnings):
    """검토 반복 한도를 다 쓴 검토(attempt > maxRounds)는 용어로 RETRY하지 않는다 (리포트를 실패시키지 않는다)."""
    assert review.retry_rounds() == 2  # YAML review 단계
    llm = FakeCaller(PASS)
    result = review.ReviewAgent().run(context("review_agent", llm, attempt=review.retry_rounds() + 1, inputs={
        "market_agent": SAMPLES["MarketResult"], "report_agent": JARGON_DRAFT}))
    assert result == PASS


def test_report_prompt_lists_jargon_without_reward_risk():
    llm = FakeCaller(PLAIN_DRAFT)
    report.ReportAgent().run(context("report_agent", llm, inputs={"market_agent": SAMPLES["MarketResult"]}))
    system, user = llm.prompts[0]
    assert "쉬운 글(plainSummary·oneLiner·reasons·risks)에는 다음 말을 쓰지 말고" in system
    for name in ("이동평균선", "지지선", "이탈", "RSI", "PER", "밸류에이션", "턴어라운드"):
        assert name in system
    assert "201,000원" in system and "영어 의견을 쓰지 않는다" in system
    assert "손익비" not in system + user  # 최소 손익비 규칙 (DECISIONS 21·22) — 말 자체도 넣지 않는다


# ---------------------------------------------------------------------- Orchestrator: RETRY → 한도 뒤 통과, 저장 전 후처리

@pytest.fixture
def flow(monkeypatch, inline_workers, no_warnings):
    monkeypatch.setattr(engine, "broker_client", lambda: None)


def review_model() -> str:
    return next(w for w in registry.execution_plan()["workers"] if w["id"] == "review_agent")["model"]


def run_with(user, drafts, reviews):
    report_row = make_report(user)
    writer = FakeWorker("report_agent", script=[copy.deepcopy(d) for d in drafts], contract="ReportDraft")
    workers = fake_team(report_agent=writer) | {"review_agent": review.ReviewAgent()}  # 검토는 진짜 Worker (LLM만 가짜)
    orchestrator.run_report(report_row, workers=workers, llm_client=FakeLlm({review_model(): list(reviews)}))
    report_row.refresh_from_db()
    retries = [e.details for e in report_row.trace_events.order_by("step") if e.action == "review_retry"]
    return report_row, writer, retries


@pytest.mark.django_db
def test_jargon_retries_then_plain_rewrite_passes(user, flow):
    report_row, writer, retries = run_with(user, [JARGON_DRAFT, PLAIN_DRAFT], [PASS, PASS])

    assert report_row.status == Report.COMPLETED
    assert len(retries) == 1 and any("이동평균선" in line for line in retries[0]["issues"])
    assert "쉬운 말로 풀어 쓴다" in writer.calls[1].instructions
    draft = report_row.results["report_agent"]
    assert draft["risks"] == ["그동안 버텨 온 187,900원 아래로 내려가면 다시 봐야 해요"] and guards.easy_jargon(draft) == []


@pytest.mark.django_db
def test_jargon_after_retry_limit_passes_with_explanations_and_tidy_text(user, flow):
    """초안이 다시 써도 용어를 쓰면 (용어 RETRY는 첫 검토에서만 — 비용 상한) 실패하지 않고, 괄호 풀이·쉼표·한국어 의견을 단 글로 완성된다."""
    report_row, writer, retries = run_with(user, [JARGON_DRAFT] * 2, [PASS] * 2)

    assert report_row.status == Report.COMPLETED and len(writer.calls) == 2
    assert [r["round"] for r in retries] == [1]
    assert report_row.results["review_agent"]["verdict"] == "PASS"
    draft = report_row.results["report_agent"]  # 추천(autotrade.recommend.sources.from_report)이 옮기는 oneLiner·reasons·risks도 이 값
    assert draft["oneLiner"] == "AI 의견은 지켜보기예요. 이동평균선(최근 며칠 동안의 평균 가격) 아래라 지켜봐요"
    assert draft["reasons"][1] == "지지선(그동안 더 내려가지 않고 버텨 온 가격대) 187,900원 근처"
    assert "AI 의견은 **지켜보기**예요" in report_row.content and "201,000원" in report_row.content
    assert draft["verdict"] == "hold"


# ---------------------------------------------------------------------- 뉴스 출처

BLOG_ITEMS = [
    {"publishedAt": "2026-10-07T01:00:00+00:00", "source": "Naver Blog", "title": "푸조, 네이버 공식 스토어서 전 차종 온라인 판매"},
    {"publishedAt": "2026-10-07T01:00:00+00:00", "source": "네이버 프리미엄콘텐츠", "title": "삼성전자 지금 사야 할까"},
    {"publishedAt": "2026-10-07T00:00:00+00:00", "source": "연합뉴스", "title": "삼성전자 신제품 발표"},
]


def test_report_news_drops_blog_sources(monkeypatch):
    monkeypatch.setattr(news, "fetch_news", lambda *args, **kwargs: copy.deepcopy(BLOG_ITEMS))
    data = news.gather(context("news_agent", None, deadline=healing.clock() + 1000))
    assert [row["source"] for row in data["news"]] == ["연합뉴스"]


def test_selection_news_drops_blog_sources():
    assert [row["source"] for row in news_screen._headlines(copy.deepcopy(BLOG_ITEMS), [])] == ["연합뉴스"]


def test_review_second_attempt_does_not_retry_for_jargon(no_warnings):
    """용어 RETRY는 첫 검토에서만 한다 (리뷰 R-6: 리포트당 작성·검토 1번씩만 더 든다)."""
    llm = FakeCaller(PASS)
    result = review.ReviewAgent().run(context("review_agent", llm, attempt=2, inputs={
        "market_agent": SAMPLES["MarketResult"], "report_agent": JARGON_DRAFT}))
    assert result == PASS


def test_review_llm_does_not_see_jargon_as_code_problem(no_warnings):
    """용어 문제는 검토 LLM의 '코드 점검 결과'에 넣지 않는다 (리뷰 R-2: LLM 규칙과 부딪혀 FAIL이 나지 않게). RETRY는 코드가 더한다."""
    llm = FakeCaller(PASS)
    result = review.ReviewAgent().run(context("review_agent", llm, inputs={
        "market_agent": SAMPLES["MarketResult"], "report_agent": JARGON_DRAFT}))
    _, user_prompt = llm.prompts[0]
    assert "전문 용어가 있습니다" not in user_prompt
    assert result["verdict"] == "RETRY"


@pytest.mark.parametrize("text", ["매출이 1조 원을 돌파했어요", "이용자 이탈이 늘 수 있어요", "외국인 자금 이탈 우려"])
def test_breakout_words_outside_price_context_are_plain(text):
    """'이탈'·'돌파'는 가격 문맥일 때만 용어다 (리뷰 R-1)."""
    assert tidy.jargon_terms(text) == [] and tidy._tidy(text, 200, True) == text


@pytest.mark.parametrize("text, want", [
    ("2026 원/달러 환율", "2026 원/달러 환율"),                                    # 리뷰 R-11
    ("[기사](https://x.com/a?type=hold) 참고: 실적", "[기사](https://x.com/a?type=hold) 참고: 실적"),  # 리뷰 R-3
    ("주가가 지지선 근처예요 (근거: 일봉 RSI)", "주가가 지지선(그동안 더 내려가지 않고 버텨 온 가격대) 근처예요 (근거: 일봉 RSI)"),  # 리뷰 R-4
])
def test_tidy_leaves_links_years_and_source_tail(text, want):
    assert tidy._tidy(text, 200, True) == want

