"""시연용 수동 시작 (DECISIONS 31장, docs/API.md manualStart): 손익비·기대값만 건너뛰고 나머지 점검·감사 기록·재주문을 지킨다."""
from datetime import timedelta

import pytest
from django.db import connection
from django.utils import timezone
from trading.models import PaperOrder

from autotrade import views
from autotrade.models import PlanEvent, TradePlan
from autotrade.plans import executor, risk
from config import engine

from .conftest import make_rec, set_price
from .test_budget import post, preview
from .test_plans import BUDGET_KRW, day_end, kinds

pytestmark = pytest.mark.django_db
CODES = ["reward_risk_low", "ev_negative"]
SKIPPED = ["손익비 0.72가 최소 기준 1.5보다 낮음", "비용을 반영한 기대값이 0 이하"]
TAG = "[시연용 수동 시작] "


def low(**kw):
    return make_rec(target=72100, **kw)  # 손익비 약 0.72, 확률 0.5라 기대값도 음수 (test_blocked_by_e2efix와 같은 값)


def manual(api, rec, **body):
    return post(api, rec, {"budgetKrw": BUDGET_KRW, "acknowledged": True, "manualStart": True} | body)


def started(api, rec) -> TradePlan:
    """시연용 수동 시작으로 활성화한 계획 (진입가 69,000원 < 지금 가격이라 체결 대기)."""
    body = manual(api, rec)
    assert body.status_code == 201, body.json()
    return TradePlan.objects.get(pk=body.json()["id"])


# --- 미리 보기 ---

def test_preview_manual_start_moves_plan_quality_codes(api, fake):
    rec = low()
    normal = preview(api, rec)
    assert normal["activatable"] is False and normal["reasonCodes"] == CODES
    assert normal["skippedCodes"] == normal["skippedReasons"] == []
    m = preview(api, rec, "?manualStart=1")
    assert m["activatable"] is True and m["reasons"] == m["reasonCodes"] == []
    assert m["skippedCodes"] == CODES and m["skippedReasons"] == SKIPPED
    assert m["approved"] is False  # 리스크 엔진의 원래 판정 그대로
    assert preview(api, rec, "?budgetKrw=1760000&manualStart=TRUE")["quantity"] == 25  # 대소문자 무시, 수량 계산은 그대로
    assert preview(api, rec, "?manualStart=0") == normal and preview(api, rec, "?manualStart=") == normal
    bad = api.get(f"/api/recommendations/{rec.id}/preview?manualStart=yes")
    assert bad.status_code == 400 and bad.json() == {"detail": views.BAD_MANUAL}


# --- 활성화 ---

def test_activate_manual_start_records_audit(api, fake, sent):
    rec = low()
    body = manual(api, rec)
    assert body.status_code == 201, body.json()
    plan = body.json()
    assert plan["manualStart"] is True and plan["status"] == "entry_pending" and plan["quantity"] == 25
    activated, checked = plan["events"][:2]
    assert activated["message"] == "웹에서 계획 활성화 (시연용 수동 시작)"
    assert activated["details"] == {"via": "web", "budgetMode": "amount", "budgetPercent": None, "budgetKrw": BUDGET_KRW,
                                    "acknowledged": True, "manualStart": True, "skippedCodes": CODES}
    assert checked["message"] == ("리스크 엔진 점검: 손익비 0.72가 최소 기준 1.5보다 낮음; 비용을 반영한 기대값이 0 이하 — "
                                  "시연용 수동 시작으로 건너뜀. 내가 정한 금액 1,760,000원으로 25주")
    assert checked["details"] == {"approved": False, "quantity": 25, "limitedBy": "내가 정한 금액",
                                  "rewardRisk": rec.reward_risk, "reasons": [], "manualStart": True,
                                  "skippedCodes": CODES, "skippedReasons": SKIPPED}
    stored = TradePlan.objects.get(pk=plan["id"])
    assert stored.manual_start is True
    assert PaperOrder.objects.get(pk=stored.order_id).requested_by == f"plan:{stored.id}"  # 주문 요청자는 그대로
    # 활성화 요청 안에서 합친 알림 하나 (시작 + 주문 접수) — 제목에만 꼬리표
    last = sent.calls[-1]
    assert sent.kinds == ["recommendation", "order_placed"]
    assert last["title"].startswith(TAG) and last["expert_title"].startswith(TAG) and not last["body"].startswith(TAG)
    listed = {p["id"]: p for p in api.get("/api/trade-plans").json()["results"]}
    assert listed[plan["id"]]["manualStart"] is True
    assert api.get(f"/api/trade-plans/{plan['id']}").json()["manualStart"] is True


def test_activate_without_manual_start_still_blocked(api, fake):
    body = post(api, low(), {"budgetKrw": BUDGET_KRW})
    assert body.status_code == 400 and body.json()["reasonCodes"] == CODES
    assert not TradePlan.objects.exists()


def test_manual_start_keeps_other_checks(api, fake):
    """손익비·기대값 말고는 그대로 막는다 — 중단 스위치·현금·매수 유의·기한·장중 가격·같은 종목."""
    def blocked(rec, **body) -> list[str]:
        r = manual(api, rec, **body)
        assert r.status_code == 400, r.json()
        return r.json()["reasonCodes"]

    engine.HALT_FILE.touch()
    try:
        rec = low()
        assert blocked(rec) == ["halted"]
        p = preview(api, rec, "?manualStart=1")
        assert p["reasonCodes"] == ["halted"] and p["skippedCodes"] == CODES and not p["activatable"]
    finally:
        engine.HALT_FILE.unlink()
    assert blocked(low(), budgetKrw=20_000_000) == ["cash_short"]
    # 가짜 현재가 200,000원이 목표가 201,000원보다 낮아 price_passed는 섞이지 않는다
    assert blocked(make_rec(symbol="000660", name="SK하이닉스", entry=190000, target=201000, stop=180000)) == ["warning_stock"]
    assert blocked(low(now=timezone.now() - timedelta(days=4))) == ["expired"]
    rec = low()
    set_price(fake, "005930", 72200)  # 장중 확인 가격이 이미 목표가(72,100원) 이상
    assert blocked(rec) == ["price_passed"]
    set_price(fake, "005930", 70000)
    assert not TradePlan.objects.exists()
    started(api, rec)
    assert blocked(rec) == ["plan_exists", "position_exists"]
    assert TradePlan.objects.count() == 1


def test_manual_start_not_needed(api, fake):
    """손익비·기대값에 막히지 않은 계획에는 시연용 표시를 붙이지 않는다 (400, 사유 코드 없음)."""
    body = manual(api, make_rec())
    assert body.status_code == 400 and body.json() == {"detail": executor.MANUAL_NOT_NEEDED}
    assert not TradePlan.objects.exists()


@pytest.mark.parametrize("bad", ["yes", "true", 1, None, [True]])
def test_manual_start_must_be_boolean(api, fake, bad):
    body = post(api, low(), {"budgetKrw": BUDGET_KRW, "manualStart": bad})
    assert body.status_code == 400 and body.json() == {"detail": views.BAD_MANUAL}
    assert not TradePlan.objects.exists()


# --- 재주문 ---

def test_manual_plan_requeue_skips_codes(api, fake, sent):
    plan = started(api, low())
    first = plan.order_id
    day_end(plan, fake)
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "entry_pending" and plan.order_id != first
    assert kinds(plan)[-1] == "order_requeued"
    assert sent.calls[-1]["kind"] == "order_requeued" and sent.calls[-1]["title"].startswith(TAG)
    assert risk.preview(plan.recommendation, plan.user, plan=plan)["skippedCodes"] == CODES


def test_requeue_follows_plan_flag(api, fake):
    """재주문 점검의 건너뛰기는 계획에 남은 manual_start로 정한다 (사건 details가 아니라)."""
    plan = started(api, low())
    TradePlan.objects.filter(pk=plan.pk).update(manual_start=False)
    day_end(plan, fake)
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "failed"
    assert PlanEvent.objects.get(plan=plan, kind="failed").details["reasonCodes"] == CODES


def test_manual_plan_requeue_still_stops_on_other_checks(api, fake, sent):
    plan = started(api, low())
    day_end(plan, fake)
    engine.HALT_FILE.touch()
    try:
        executor.step(plan, timezone.now())
        plan.refresh_from_db()
        assert plan.status == "failed"
        assert PlanEvent.objects.get(plan=plan, kind="failed").details["reasonCodes"] == ["halted"]
        assert sent.calls[-1]["kind"] == "failed" and sent.calls[-1]["title"].startswith(TAG)
    finally:
        engine.HALT_FILE.unlink()


# --- 일반 계획 · 옛 코드 ---

def test_normal_plan_is_not_manual(api, fake, sent):
    rec = make_rec()
    plan = post(api, rec, {"budgetKrw": BUDGET_KRW}).json()
    assert plan["manualStart"] is False
    assert "manualStart" not in plan["events"][0]["details"] and "manualStart" not in plan["events"][1]["details"]
    assert not sent.calls[-1]["title"].startswith(TAG)
    assert preview(api, rec)["skippedCodes"] == []


def test_manual_start_db_default_for_old_code(user):
    """manual_start 열을 모르는 옛 코드가 INSERT해도 DB가 FALSE를 채운다 (공유 개발 DB·배포 중의 옛 컨테이너)."""
    rec = make_rec()
    now = timezone.now()
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO trade_plans (recommendation_id, user_id, symbol, name, market, currency, status, via, quantity,"
            " entry_price, target_price, stop_price, holding_days, entry_deadline, activated_at, updated_at)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            [rec.id, user.id, rec.symbol, rec.name, rec.market, rec.currency, "cancelled", "web", 10, rec.entry_price,
             rec.target_price, rec.stop_price, rec.holding_days, rec.valid_until, now, now])
    assert TradePlan.objects.get().manual_start is False
