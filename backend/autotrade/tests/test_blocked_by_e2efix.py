"""Recommendation.blockedBy (UX-2, docs/API.md Recommendation, DECISIONS 23장)와 사유 문장의 조사 (UX-5).

blockedBy는 계좌와 무관한 사유 코드(reward_risk_low·ev_negative·expired)를 미리 보기와 같은 계산(assess·is_open)으로 낸다.
"""
from datetime import timedelta

import pytest
from django.utils import timezone

from autotrade.plans import risk

from .conftest import make_rec

pytestmark = pytest.mark.django_db

ACCOUNT_FREE = ("reward_risk_low", "ev_negative", "expired")


def listed(api, rec) -> dict:
    results = api.get("/api/recommendations?status=all").json()["results"]
    return next(r for r in results if r["id"] == rec.id)


def preview_codes(api, rec) -> list[str]:
    return api.get(f"/api/recommendations/{rec.id}/preview").json()["reasonCodes"]


def test_low_reward_risk_is_blocked(api, fake):
    rec = make_rec(target=72100, probability=0.7)  # 손익비 약 0.72, 기대값은 양수 (확률이 높아서)
    assert rec.reward_risk == pytest.approx(0.72, abs=0.01) and rec.expected_return > 0
    assert listed(api, rec)["blockedBy"] == ["reward_risk_low"]
    assert api.get(f"/api/recommendations/{rec.id}").json()["blockedBy"] == ["reward_risk_low"]
    assert preview_codes(api, rec) == ["reward_risk_low"]


def test_good_recommendation_is_not_blocked(api, fake):
    rec = make_rec(target=86000)  # 손익비 약 4.25, 기대값 양수
    assert rec.reward_risk == pytest.approx(4.25, abs=0.01) and rec.expected_return > 0
    assert listed(api, rec)["blockedBy"] == []
    assert preview_codes(api, rec) == []


def test_negative_expected_value_and_both(api, fake):
    ev = make_rec(probability=0.2)  # 손익비 약 2.72는 넘지만 확률이 낮아 기대값 음수
    assert ev.reward_risk >= 1.5 and ev.expected_return < 0
    assert listed(api, ev)["blockedBy"] == ["ev_negative"]
    both = make_rec(symbol="035420", name="NAVER", target=72100)  # 손익비 미달 + 확률 0.5라 기대값도 음수
    assert listed(api, both)["blockedBy"] == ["reward_risk_low", "ev_negative"]


def test_expired_is_included(api, fake):
    old = make_rec(now=timezone.now() - timedelta(days=4))
    assert listed(api, old)["blockedBy"] == ["expired"] and listed(api, old)["status"] == "expired"
    old_low = make_rec(symbol="035420", name="NAVER", target=72100, now=timezone.now() - timedelta(days=4))
    assert listed(api, old_low)["blockedBy"] == ["reward_risk_low", "ev_negative", "expired"]


def test_blocked_by_agrees_with_preview(api, fake, user):
    """미리 보기 reasonCodes에서 계좌와 무관한 코드만 고르면 blockedBy와 같다 (같은 계산·같은 순서)."""
    now = timezone.now()
    recs = [make_rec(), make_rec(target=72100, probability=0.7), make_rec(probability=0.2),
            make_rec(target=72100), make_rec(now=now - timedelta(days=4)),
            make_rec(target=72100, now=now - timedelta(days=4)),
            make_rec(symbol="000660", name="SK하이닉스", entry=190000, target=230000, stop=180000)]  # 매수 유의 (계좌 쪽 사유)
    for rec in recs:
        codes = risk.preview(rec, user)["reasonCodes"]
        assert risk.blocked_by(rec) == [c for c in codes if c in ACCOUNT_FREE], (rec.reward_risk, codes)
        assert listed(api, rec)["blockedBy"] == risk.blocked_by(rec)


def test_blocked_by_on_plan_detail_and_activation(api, fake):
    rec = make_rec()
    plan = api.post(f"/api/recommendations/{rec.id}/activate", {"budgetKrw": 1_000_000}, format="json").json()
    assert plan["recommendation"]["blockedBy"] == []
    assert api.get(f"/api/trade-plans/{plan['id']}").json()["recommendation"]["blockedBy"] == []


@pytest.mark.parametrize("target,sentence", [(71900, "손익비 0.67이 최소 기준 1.5보다 낮음"),    # 칠 → 이
                                             (72100, "손익비 0.72가 최소 기준 1.5보다 낮음")])  # 이 → 가
def test_reward_risk_sentence_particle(api, fake, target, sentence):
    """숫자 뒤 조사는 숫자를 읽는 소리의 받침으로 고른다 (UX-5)."""
    rec = make_rec(target=target, probability=0.7)
    assert api.get(f"/api/recommendations/{rec.id}/preview").json()["reasons"] == [sentence]


def test_us_budget_sentence_has_no_double_particle(api, fake):
    rec = make_rec(symbol="AAPL", name="Apple", market_="US", entry=190, target=230, stop=180, price_at_creation=200)
    tiny = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=1000").json()
    sentence = next(r for r in tiny["reasons"] if "최소 주문 금액" in r)
    assert "이(가)" not in sentence and sentence == "내가 정한 금액으로 살 매수 금액($0.71)이 최소 주문 금액 $1보다 적음"


def test_halt_switch_blocks_every_recommendation(api, fake):
    """중단 스위치는 계좌와 무관하게 모두를 막는다 — 목록에서도 halted (리뷰 R-7)."""
    from config import engine
    rec = make_rec(target=86000)
    engine.HALT_FILE.touch()
    try:
        assert listed(api, rec)["blockedBy"] == ["halted"]
        assert preview_codes(api, rec) == ["halted"]
    finally:
        engine.HALT_FILE.unlink()
    assert listed(api, rec)["blockedBy"] == []
