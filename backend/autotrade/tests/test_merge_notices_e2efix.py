"""알림 합치기 (UX-9, docs/API.md "알림 합치기", DECISIONS 23장).

활성화 요청 하나 안에서 이어진 계획 사건(activated → risk_checked → order_placed → filled)은 웹 알림·Discord 보낼 편지함에
마지막 상태 하나만 남긴다. PlanEvent는 다 남고, 엔진 루프가 나중에 만드는 사건은 지금처럼 하나씩 알린다.
"""
import pytest
from django.utils import timezone
from notifications import service as notices
from notifications.models import Notification, OutboxMessage
from notifications.service import notify as real_notify  # 모듈을 읽을 때 잡아 둔 진짜 notify (sent fixture가 바꾸기 전)
from paper_engine.wording import forbidden_phrases
from trading import service

from autotrade.plans import executor
from autotrade import text
from autotrade.models import PlanEvent, TradePlan
from config.api import Rejected, Unavailable

from .conftest import make_rec, set_price
from .test_plans import BUDGET_KRW, PASSED, activate
from .test_text import plan_of

pytestmark = pytest.mark.django_db

PLAN_KINDS = ("plan_activated", "order_placed", "order_requeued", "filled", "closed", "cancelled", "expired", "failed")




def plan_calls(sent) -> list[dict]:
    return [c for c in sent.calls if c["kind"] in PLAN_KINDS]


def events(plan_id) -> list[str]:
    return list(PlanEvent.objects.filter(plan_id=plan_id).order_by("step").values_list("kind", flat=True))


def test_immediate_fill_sends_one_bought_notice(api, fake, sent):
    rec = make_rec(entry=70000, target=82000, stop=67000)  # 지금 가격 70,000원 = 진입가 → 바로 체결
    plan = activate(api, rec).json()
    assert plan["status"] == "holding"
    assert events(plan["id"]) == ["activated", "risk_checked", "order_placed", "filled"]  # 사건은 다 남는다
    [call] = plan_calls(sent)
    assert call["kind"] == "filled" and call["link"] == f"/plans/{plan['id']}" and call["discord"] is True
    assert call["title"] == "삼성전자 모의 계좌에서 샀어요"
    assert call["body"].startswith("모의 자동매매를 시작하자마자 모의 계좌에서 삼성전자 ")
    assert "기다려요" not in call["body"]  # 이미 샀는데 '주문 접수 … 기다려요'가 오지 않는다


def test_pending_limit_sends_one_order_notice_with_start(api, fake, sent):
    rec = make_rec()  # 진입가 69,000원 < 지금 가격 → 지정가 대기
    plan = activate(api, rec).json()
    assert plan["status"] == "entry_pending"
    assert events(plan["id"]) == ["activated", "risk_checked", "order_placed"]
    [call] = plan_calls(sent)
    assert call["kind"] == "order_placed"
    assert call["title"] == "삼성전자 모의 자동매매를 시작하고 매수 주문을 냈어요"
    assert "69,000원 이하에 사는 주문을 냈어요" in call["body"] and "80,000원이 되면 팔고" in call["body"]
    assert "사지 못하면 사지 않고 끝나요" in call["body"]  # 시작 안내 (진입 기한)
    assert call["expert_title"] == "삼성전자 자동매매 계획 활성화 · 진입 주문 접수"
    assert f"모의 주문 #{plan['orderId']}" in call["expert_body"]


def test_first_order_rejected_sends_only_failed(api, fake, sent, monkeypatch):
    def reject(*args, **kwargs):
        raise Rejected("매수 가능 금액이 부족합니다.")
    monkeypatch.setattr(service, "buy", reject)
    plan = activate(api, make_rec()).json()
    assert plan["status"] == "failed"
    assert events(plan["id"]) == ["activated", "risk_checked", "failed"]
    assert [c["kind"] for c in plan_calls(sent)] == ["failed"]


def test_transient_first_order_error_sends_only_started(api, fake, sent, monkeypatch):
    def down(*args, **kwargs):
        raise Unavailable("증권사 조회 실패")
    monkeypatch.setattr(service, "buy", down)
    plan = activate(api, make_rec()).json()
    assert plan["status"] == "active"  # 엔진 루프가 다시 낸다
    assert [c["kind"] for c in plan_calls(sent)] == ["plan_activated"]


def test_engine_loop_events_are_still_sent_one_by_one(api, fake, sent):
    plan = TradePlan.objects.get(pk=activate(api, make_rec()).json()["id"])
    set_price(fake, "005930", 68500)
    service.sync_accounts(timezone.now(), lambda text: None)
    executor.tick(timezone.now(), lambda text: None)
    plan.refresh_from_db()
    assert plan.status == "holding"
    assert [c["kind"] for c in plan_calls(sent)] == ["order_placed", "filled"]
    filled = plan_calls(sent)[-1]
    assert filled["body"].startswith("모의 계좌에서 삼성전자 25주를 68,500원에 샀어요.")  # 시작 안내 없는 원래 문장


def test_merged_notice_leaves_one_web_row_and_one_outbox_message(api, fake, sent, user, monkeypatch):
    rec = make_rec(entry=70000, target=82000, stop=67000)
    sent.flush()  # 추천 알림까지는 기록기로
    monkeypatch.setattr(notices, "notify", real_notify)
    plan = activate(api, rec).json()
    sent.flush()  # 커밋 뒤 콜백(모은 알림 → 마지막 하나 보내기)을 돌린다
    rows = list(Notification.objects.filter(user=user, link=f"/plans/{plan['id']}"))
    assert [n.kind for n in rows] == ["filled"] and "샀어요" in rows[0].title
    assert list(OutboxMessage.objects.filter(kind__in=PLAN_KINDS).values_list("kind", flat=True)) == ["filled"]


def test_rolled_back_activation_sends_nothing(fake, user, sent, monkeypatch):
    """계획 만들기가 롤백되면 (plan_exists 경합) 모은 알림도 보내지 않는다."""
    from .test_plans import plan_in
    plan_in("active", make_rec(), user)
    monkeypatch.setattr(executor.risk, "preview", lambda *a, **kw: PASSED)
    with pytest.raises(executor.Blocked):
        executor.activate(make_rec(), user, BUDGET_KRW)
    assert plan_calls(sent) == []


@pytest.mark.parametrize("currency", ["KRW", "USD"])
def test_merged_wording_rules(currency):
    """합친 문장도 쉬운 문장에 "모의"가 있고 권유 표현이 없다 (docs/API.md "알림 문장")."""
    plan = plan_of(currency)
    fill = plan.entry_price - (100 if currency == "KRW" else 1)
    for notice in (text.order_placed(plan, 5, plan.quantity, started=True), text.filled(plan, fill, plan.quantity, started=True)):
        assert "모의" in notice.title + notice.body
        for sentence in (notice.title, notice.body, notice.expert_title, notice.expert_body, notice.numbers):
            assert forbidden_phrases(sentence) == [], sentence
