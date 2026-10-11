"""알림 문장 (B6, autotrade/text.py): 쉬운 문장에 "모의", 권유 표현 없음, 장중 가격 숫자 없음.

DB 없이 저장하지 않은 추천·계획 객체로 문장만 만든다.
"""
from datetime import datetime

import pytest
from notifications.service import Notice
from paper_engine.wording import forbidden_phrases

from autotrade import text
from autotrade.models import Recommendation, TradePlan

from .conftest import KST

AT = datetime(2026, 9, 22, 10, 0, tzinfo=KST)
DEADLINE = datetime(2026, 9, 25, 10, 0, tzinfo=KST)
# 쉬운 문장에 "모의"가 꼭 있어야 하는 kind (docs/API.md "알림 문장")
MOCK_KINDS = ("plan_activated", "order_placed", "order_requeued", "filled", "closed", "cancelled", "expired", "failed")


def rec_of(source=Recommendation.REPORT, currency="KRW", **kw) -> Recommendation:
    us = currency == "USD"
    values = dict(id=7, source=source, report_id=3 if source == Recommendation.REPORT else None,
                  analysis_id=4 if source == Recommendation.ANALYSIS else None, symbol="AAPL" if us else "005930",
                  name="Apple" if us else "삼성전자", market="US" if us else "KR", currency=currency,
                  entry_price=190 if us else 69000, target_price=230 if us else 80000, stop_price=180 if us else 66000,
                  holding_days=10, probability=0.5, probability_assumed=True, target_return=0.159, stop_loss_rate=-0.043,
                  reward_risk=2.34, expected_return=0.04, summary="한 줄 결론", valid_until=DEADLINE, created_at=AT)
    return Recommendation(**(values | kw))


def plan_of(currency="KRW") -> TradePlan:
    rec = rec_of(Recommendation.ANALYSIS, currency)
    return TradePlan(id=11, recommendation=rec, symbol=rec.symbol, name=rec.name, market=rec.market,
                     currency=currency, quantity=25 if currency == "KRW" else 1.5, entry_price=rec.entry_price,
                     target_price=rec.target_price, stop_price=rec.stop_price, holding_days=10,
                     entry_deadline=DEADLINE)


def plan_notices(plan: TradePlan) -> dict[str, list]:
    """kind → 그 kind의 모든 문장 변형."""
    fill = plan.entry_price - (100 if plan.currency == "KRW" else 1)
    return {
        "plan_activated": [text.plan_activated(plan)],
        "order_placed": [text.order_placed(plan, 5, plan.quantity)],
        "order_requeued": [text.order_requeued(plan, 6, plan.quantity, plan.quantity),
                           text.order_requeued(plan, 6, 1, plan.quantity)],
        "filled": [text.filled(plan, fill, plan.quantity)],
        "closed": [text.closed(plan, plan.target_price, reason, pnl, plan.quantity)
                   for reason in (*text.EXIT_LABEL, "UNKNOWN", None) for pnl in (12000.0, -3000.0, None)],
        "cancelled": [text.ended(plan, TradePlan.CANCELLED, why, "사용자가 계획을 중단함")
                      for why in ("user_stopped", "order_cancelled")],
        "expired": [text.ended(plan, TradePlan.EXPIRED, why, "진입 기한까지 지정가에 체결되지 않음")
                    for why in ("no_order_by_deadline", "unfilled_by_deadline")],
        "failed": [text.ended(plan, TradePlan.FAILED, why, "주문할 수 없음: …", codes)
                   for why in ("order_rejected", "engine_cancelled", "cash_short", "requeue_blocked",
                               "requeue_too_small", "모르는 까닭")
                   for codes in ((), ("price_passed", "price_passed", "halted", "모르는_코드"))],
    }


PLANS = [plan_of(), plan_of(currency="USD")]
RECS = [rec_of(source) for source in (Recommendation.REPORT, Recommendation.ANALYSIS, Recommendation.DEMO)] + \
    [rec_of(currency="USD")]


@pytest.mark.parametrize("plan", PLANS, ids=["kr", "us"])
def test_every_easy_order_fill_exit_sentence_says_mock(plan):
    notices = plan_notices(plan)
    assert set(notices) == set(MOCK_KINDS)
    for kind, items in notices.items():
        for n in items:
            assert "모의" in n.title and "모의" in n.body, (kind, n)


@pytest.mark.parametrize("plan", PLANS, ids=["kr", "us"])
def test_no_persuasion_in_any_plan_sentence(plan):
    for kind, items in plan_notices(plan).items():
        for n in items:
            for sentence in (n.title, n.body, n.expert_title, n.expert_body, n.numbers or ""):
                assert forbidden_phrases(sentence) == [], (kind, sentence)


@pytest.mark.parametrize("plan", PLANS, ids=["kr", "us"])
def test_manual_tagged_marks_titles_and_keeps_rules(plan):
    """시연용 수동 시작 계획의 알림 (DECISIONS 31장): 쉬운·전문가 제목 앞에 꼬리표, 본문·숫자 줄은 그대로, 규칙(모의·권유 표현 없음)도 그대로."""
    for kind, items in plan_notices(plan).items():
        for n in items:
            t = text.manual_tagged(n)
            assert t.title == f"{text.MANUAL_START_TAG} {n.title}" and t.expert_title == f"{text.MANUAL_START_TAG} {n.expert_title}"
            assert (t.body, t.expert_body, t.numbers) == (n.body, n.expert_body, n.numbers)
            assert "모의" in t.title and "모의" in t.body, (kind, t)
            for sentence in (t.title, t.expert_title):
                assert forbidden_phrases(sentence) == [], (kind, sentence)
    assert text.manual_tagged(Notice(title="제목", body="본문")).expert_title is None


@pytest.mark.parametrize("rec", RECS, ids=["report", "analysis", "demo", "us"])
def test_recommendation_wording(rec):
    n = text.recommendation(rec)
    for sentence in (n.title, n.body, n.expert_title, n.expert_body, n.numbers):
        assert forbidden_phrases(sentence) == [], sentence
    assert "모의 자동매매" in n.body and "9월 25일 10:00" in n.body
    first = n.body.splitlines()[0]
    if rec.source == Recommendation.REPORT:  # 리포트 완성 알림을 대신한다 (B7)
        assert first == "리포트가 완성됐어요" == n.expert_body.splitlines()[0]
    else:
        assert first != "리포트가 완성됐어요"
    if rec.source == Recommendation.DEMO:
        assert "AI 아님" in n.title and "AI 아님" in n.expert_title


def test_sentences_use_only_plan_numbers_and_facts():
    """쉬운 문장의 숫자는 진입·목표·손절·체결가·청산가·손익뿐이다 (장중 확인 가격을 받지 않는다)."""
    plan = plan_of()
    n = text.filled(plan, 68500, 25)
    assert n.body == ("모의 계좌에서 삼성전자 25주를 68,500원에 샀어요. 80,000원이 되면 팔고, 66,000원 아래로 내려가면 "
                      "손실이 더 커지지 않게 팔아요.")
    assert n.expert_title == "삼성전자 진입 체결" and n.expert_body == "68,500원 × 25주. 목표 80,000원 / 손절 66,000원 자동 감시"
    assert n.numbers == "체결 68,500원 × 25주 · 목표 80,000원 · 손절 66,000원"
    closed = text.closed(plan, 81000, "TARGET", 12000.0, 25)
    assert closed.expert_title == "삼성전자 청산 · 목표가 도달" and closed.numbers == "청산 81,000원 · 목표가 도달 · 실현 손익 +12,000원"
    assert closed.body == "목표 가격에 닿아 모의 계좌에서 삼성전자 25주를 81,000원에 모두 팔았어요. 실현 손익은 +12,000원이에요 (비용 포함)."


def test_ended_adds_plain_reason_sentences_once():
    n = text.ended(plan_of(), TradePlan.FAILED, "requeue_blocked", "다시 주문할 수 없음: …",
                   ["price_passed", "price_passed", "nope"])
    assert n.body.count("가격이 이미 목표 가격을 넘었거나") == 1 and n.expert_body == "다시 주문할 수 없음: …"
    assert n.expert_title == "삼성전자 계획 실패"
