"""추천 만들기: 수치(리스크 엔진과 같은 계산), 리포트·분석에서, 만료, 시연 규칙 추천, 알림."""
from datetime import timedelta

import pytest
from analysis.models import AnalysisRun
from django.utils import timezone
from paper_engine.judge.risk import AccountContext, assess
from paper_engine.judge.scenario import Scenario
from reports.models import Report

from autotrade.recommend import demo, sources
from autotrade.plans import risk
from autotrade.models import Recommendation
from autotrade.tokens import activation_token, check_token

from .conftest import close_of, make_rec

pytestmark = pytest.mark.django_db

DRAFT = {"title": "삼성전자", "verdict": "buy", "oneLiner": "반도체 업황 회복", "markdown": "...",
         "reasons": ["실적 개선", "수급", "업황", "네 번째는 버림"], "risks": ["환율"],
         "targets": {"entry": 69000, "target": 80000, "stop": 66000, "holdingDays": 7, "probability": 0.55},
         "confidence": 72, "citations": []}


def report_of(user, results=None, status=Report.COMPLETED) -> Report:
    return Report.objects.create(user=user, symbol="005930", name="삼성전자", market="KR", status=status,
                                 results={"report_agent": DRAFT} if results is None else results,
                                 finished_at=timezone.now())


def analysis_of(verdict="BUY", best=None, requested_by="alice") -> AnalysisRun:
    best = {"proposer": "m", "selected": True, "passed": True, "score": 80, "probability": None,
            "entryPrice": 69000, "targetPrice": 80000, "stopPrice": 66000, "holdingDays": 30,
            "rationale": ["20일선 지지", "거래량 증가"], "invalidation": "66,000원 이탈", "rejectReasons": []} \
        if best is None else best
    return AnalysisRun.objects.create(run_file=f"runs/{AnalysisRun.objects.count()}.json", symbol="005930", name="삼성전자", market="KR",
                                      currency="KRW", analyzed_at=timezone.now(), verdict=verdict,
                                      price_at_analysis=70100, best=best, requested_by=requested_by)


@pytest.mark.parametrize("market,currency", [("KR", "KRW"), ("US", "USD")])
def test_metrics_match_risk_engine(market, currency):
    entry, target, stop, p = 100.0, 125.0, 92.0, 0.45
    m = risk.metrics(entry, target, stop, p, market)
    ctx = AccountContext(equity_krw=10_000_000, buying_power=10_000_000, commission_rate=0.001 if market == "KR"
                         else 0.002)
    a = assess(Scenario(symbol="X", currency=currency, horizon="SWING", entry_price=entry, target_price=target,
                        stop_price=stop, probability=p, holding_days=10), ctx)
    assert m["rewardRisk"] == pytest.approx(a.reward_risk)
    assert m["expectedReturn"] == pytest.approx(a.expected_return)
    assert m["targetReturn"] == pytest.approx(0.25) and m["stopLossRate"] == pytest.approx(-0.08)
    target_for = risk.target_for(entry, stop, 2.4, market)
    assert risk.metrics(entry, target_for, stop, p, market)["rewardRisk"] == pytest.approx(2.4)


def test_from_report_makes_one_recommendation(user, sent):
    report = report_of(user, {"report_agent": DRAFT, "risk_agent": {"level": "medium", "flags": []}})
    rec = sources.from_report(report)
    assert rec.source == "report" and rec.report == report and rec.requested_by == user
    assert (rec.entry_price, rec.target_price, rec.stop_price, rec.holding_days) == (69000, 80000, 66000, 7)
    assert rec.probability == 0.55 and not rec.probability_assumed and rec.confidence == 72
    assert rec.summary == "반도체 업황 회복" and rec.reasons == ["실적 개선", "수급", "업황"] and rec.risks == ["환율"]
    assert rec.risk_level == "medium" and rec.status == "open"
    assert rec.valid_until == rec.created_at + timedelta(days=3)
    assert sources.from_report(report) is None  # 리포트 하나 → 추천 하나
    assert Recommendation.objects.count() == 1
    call = sent.calls[0]
    assert call["kind"] == "recommendation" and call["users"] == user
    assert call["expert_title"] == "AI 추천 · 삼성전자 (005930)"
    assert "진입 69,000원" in call["expert_body"] and "목표 80,000원 (+15.9%)" in call["expert_body"]
    # 리포트 추천 알림은 본문 첫 줄이 "리포트가 완성됐어요" (리포트 완성 알림을 대신한다 — 쉬운 문장·전문가 문장 모두)
    assert call["body"].splitlines()[0] == "리포트가 완성됐어요" == call["expert_body"].splitlines()[0]
    assert "69,000원에 사서 80,000원이 되면 팔고" in call["body"] and call["title"] == "삼성전자 새 매매 계획 제안 · AI 리포트"
    assert call["numbers"].startswith("진입 69,000원 · 목표 80,000원 (+15.9%)")
    assert call["link"] == f"/recommendations/{rec.id}" and call["link_label"] == "계획 활성화"
    token = call["discord_link"].split("?t=")[1]
    assert check_token(rec, token)


@pytest.mark.parametrize("results", [
    {"report_agent": DRAFT | {"verdict": "hold"}},
    {"report_agent": DRAFT | {"targets": {"entry": 69000, "target": 80000, "stop": 70000}}},  # 손절 > 진입
    {"report_agent": DRAFT | {"targets": {"entry": 69000, "target": None, "stop": 66000}}},
    {"report_agent": DRAFT | {"targets": DRAFT["targets"] | {"probability": 1.5}}},
    {},
])
def test_from_report_skips_bad_drafts(user, sent, results):
    assert sources.from_report(report_of(user, results)) is None
    assert not Recommendation.objects.exists() and sent.calls == []


def test_from_report_needs_completed(user):
    assert sources.from_report(report_of(user, status=Report.RUNNING)) is None


def test_from_report_ignores_selection_runs(user, sent):
    """매매 종목 선정 실행(team stock_selection)은 종목 리포트가 아니다 — buy 초안 모양이 있어도 추천을 만들지 않는다."""
    selection = report_of(user)
    Report.objects.filter(pk=selection.pk).update(team=Report.STOCK_SELECTION)
    selection.refresh_from_db()
    assert sources.from_report(selection) is None
    assert not Recommendation.objects.exists() and sent.calls == []


def test_from_report_defaults(user):
    rec = sources.from_report(report_of(user, {"report_agent": DRAFT | {
        "targets": {"entry": 69000, "target": 80000, "stop": 66000, "holdingDays": None, "probability": None}}}))
    assert rec.holding_days == 10 and rec.probability == 0.5 and rec.probability_assumed and rec.risk_level is None


def test_from_analysis(user, sent):
    run = analysis_of()
    rec = sources.from_analysis(run)
    assert rec.source == "analysis" and rec.analysis == run and rec.requested_by == user
    # priceAtCreation은 분석 시각 가격(70,100)이 아니라 만들 때의 종가 — 증권사가 없으면 None
    assert rec.holding_days == 20 and rec.probability_assumed and rec.price_at_creation is None
    assert rec.summary == "20일선 지지" and rec.risks == ["시나리오가 틀렸다고 볼 조건: 66,000원 이탈"]
    assert rec.confidence == 80
    assert sources.from_analysis(run) is None
    assert sources.from_analysis(analysis_of(verdict="PASS")) is None
    assert sent.kinds == ["recommendation"]


def test_from_analysis_without_user_notifies_team(sent):
    rec = sources.from_analysis(analysis_of(requested_by="strategy:1"))
    assert rec.requested_by is None and sent.calls[0]["users"] is None


def test_collect_and_expire(user):
    report_of(user)
    analysis_of()
    old = make_rec(source="demo", now=timezone.now() - timedelta(days=4))
    logs = []
    assert sources.collect(timezone.now(), logs.append) == 2
    assert sources.collect(timezone.now(), logs.append) == 0
    old.refresh_from_db()
    assert old.status == "expired"
    assert Recommendation.objects.filter(status="open").count() == 2
    assert any("만료" in line for line in logs)


def test_collect_ignores_selection_runs(user, monkeypatch):
    """추천 수집은 끝난 종목 리포트만 본다 (선정 실행을 7일 동안 매 바퀴 다시 보지 않는다)."""
    report = report_of(user)
    Report.objects.create(team=Report.STOCK_SELECTION, source=Report.AUTO, symbol="KR", name="오늘의 매매 종목 선정",
                          market="KR", status=Report.COMPLETED, finished_at=timezone.now(),
                          results={"selector_agent": {"summary": "x", "picks": []}, "report_agent": DRAFT})
    seen = []
    real = sources.from_report

    def spy(item, now):
        seen.append(item.id)
        return real(item, now)
    monkeypatch.setattr(sources, "from_report", spy)
    assert sources.collect(timezone.now(), [].append) == 1
    assert seen == [report.id]
    assert list(Recommendation.objects.values_list("report_id", flat=True)) == [report.id]


def test_collect_logs_one_error_and_continues(user, monkeypatch):
    report_of(user)
    analysis_of()

    def boom(report, now):
        raise RuntimeError("깨진 리포트")
    monkeypatch.setattr(sources, "from_report", boom)
    logs = []
    assert sources.collect(timezone.now(), logs.append) == 1
    assert any("깨진 리포트" in line for line in logs)


def test_token_checks_id_and_expiry():
    rec, other = make_rec(), make_rec(symbol="000660", name="SK하이닉스")
    token = activation_token(rec)
    assert check_token(rec, token) and not check_token(other, token) and not check_token(rec, token + "x")
    Recommendation.objects.filter(pk=rec.pk).update(valid_until=rec.created_at + timedelta(seconds=0))
    rec.refresh_from_db()
    assert not check_token(rec, token)


# --- 시연 추천 ---

def test_price_at_creation_is_close_for_every_source(user, fake):
    """priceAtCreation = 만들 때의 직전 정규장 종가 (장마감 기준). 분석 추천도 분석 시각 가격이 아니다."""
    close = close_of(70000)
    assert sources.from_report(report_of(user)).price_at_creation == close
    assert sources.from_analysis(analysis_of()).price_at_creation == close
    assert make_rec(symbol="005935", name="삼성전자우", price_at_creation=sources._FETCH).price_at_creation == \
        close_of(60000)
    assert demo.recommend(user, "000660").price_at_creation == close_of(200000)


def test_demo_recommendation_passes_risk_engine(user, fake, sent):
    rec = demo.recommend(user)
    assert rec.source == "demo" and rec.symbol == "005930" and rec.requested_by == user
    # 진입가 = 직전 정규장 종가(69,758.6원)를 호가 단위로 내린 값. 장중 가격(70,000원)·오늘 미완성 봉을 쓰지 않는다
    assert rec.entry_price == 69700 and rec.price_at_creation == close_of(70000)
    assert rec.stop_price < rec.entry_price < rec.target_price
    assert rec.entry_price % 100 == 0 and rec.stop_price % 100 == 0 and rec.target_price % 100 == 0
    assert rec.reward_risk >= 2.4 and rec.probability == 0.45 and rec.probability_assumed
    assert rec.confidence is None and rec.holding_days == 10
    assert rec.summary.startswith("연습용 예시 계획 (AI 아님)") and demo.NOT_AI in rec.risks
    assert sent.calls[0]["expert_title"] == "연습용 예시 계획(AI 아님) · 삼성전자 (005930)"
    assert sent.calls[0]["title"] == "삼성전자 새 매매 계획 제안 · 연습용 예시 계획 (AI 아님)"
    preview = risk.preview(rec, user)
    assert preview["approved"] and preview["activatable"], preview["reasons"]
    assert demo.recommend(user).symbol == "000660"  # 오늘 시연 추천이 없는 다음 종목


def test_demo_api(api, fake):
    body = api.post("/api/recommendations/demo", {"symbol": "005930"}, format="json")
    assert body.status_code == 201, body.json()
    rec = body.json()
    assert rec["source"] == "demo" and rec["sourceId"] is None and rec["requestedBy"] == "alice"
    assert rec["myPlan"] is None and rec["planCount"] == 0 and rec["status"] == "open"
    assert api.post("/api/recommendations/demo", {"symbol": "NOPE"}, format="json").status_code == 400


def test_demo_daily_limit(api, fake, monkeypatch):
    monkeypatch.setenv("AUTOTRADE_DEMO_PER_USER", "1")
    assert api.post("/api/recommendations/demo", {}, format="json").status_code == 201
    over = api.post("/api/recommendations/demo", {}, format="json")
    assert over.status_code == 429 and "한도" in over.json()["detail"]


def test_demo_off(api, fake, monkeypatch):
    monkeypatch.setenv("AUTOTRADE_DEMO", "off")
    off = api.post("/api/recommendations/demo", {}, format="json")
    assert off.status_code == 403 and "AUTOTRADE_DEMO" in off.json()["detail"]


def test_demo_needs_candles(api, fake):
    fake.short = True
    short = api.post("/api/recommendations/demo", {"symbol": "005930"}, format="json")
    assert short.status_code == 400 and "일봉이 부족" in short.json()["detail"]


def test_demo_without_broker_is_503(api):
    assert api.post("/api/recommendations/demo", {}, format="json").status_code == 503


def test_demo_command(fake, sent):
    from io import StringIO

    from django.core.management import call_command
    out = StringIO()
    call_command("demo_recommend", "--symbol", "005930", stdout=out)
    assert "시연 추천 #" in out.getvalue()
    assert Recommendation.objects.get().requested_by is None and sent.calls[0]["users"] is None


def test_create_rounds_prices_to_ticks_like_paper_orders(user):
    """AI 가격은 모의 주문처럼 호가 단위로 내린 뒤 순서·수치를 계산한다."""
    rec = make_rec(entry=69050, target=80070, stop=66010)
    same = make_rec(symbol="005935", name="삼성전자우")
    assert (rec.entry_price, rec.target_price, rec.stop_price) == (69000, 80000, 66000)
    assert rec.reward_risk == pytest.approx(same.reward_risk) and rec.expected_return == pytest.approx(
        same.expected_return)
    us = make_rec(symbol="AAPL", name="Apple", market_="US", entry=190.567, target=230.999, stop=180.001,
                  price_at_creation=200)
    assert (us.entry_price, us.target_price, us.stop_price) == (190.56, 230.99, 180.0)
    with pytest.raises(ValueError):  # 맞추면 진입가 = 손절가
        make_rec(entry=69050, stop=69010)
