"""리포트·계획 제안 지우기와 가격이 지난 추천 자동 정리 (docs/API.md "리포트·계획 제안 지우기"·"가격이 지난 계획 제안 자동 정리", DECISIONS 25장).

지우기는 숨김이다 (행은 남고 API에서만 빠진다). 만든 팀원만, 끝난 리포트만, 진행 중 계획이 없을 때만 지운다.
"""
from datetime import timedelta

import pytest
from django.utils import timezone
from reports.limits import quota
from reports.models import Report
from rest_framework.exceptions import NotFound

from autotrade.plans import executor
from autotrade import hide
from autotrade.recommend import sources
from autotrade.models import Recommendation, TradePlan

from .conftest import login, make_rec, set_price

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def fresh_invalidate(monkeypatch):
    monkeypatch.setattr(sources, "_invalidated_at", None)  # 1분 주기를 테스트마다 처음부터


def finished_report(user, status=Report.COMPLETED, **fields) -> Report:
    values = {"symbol": "005930", "name": "삼성전자", "market": "KR", "status": status, "finished_at": timezone.now()}
    return Report.objects.create(user=user, **(values | fields))


def report_rec(report: Report, **kw) -> Recommendation:
    return make_rec(source=Recommendation.REPORT, report=report, requested_by=report.user, **kw)


def live_plan(rec: Recommendation, user, status=TradePlan.ACTIVE) -> TradePlan:
    return TradePlan.objects.create(recommendation=rec, user=user, symbol=rec.symbol, name=rec.name, market=rec.market,
                                    currency=rec.currency, status=status, quantity=1, entry_price=rec.entry_price,
                                    target_price=rec.target_price, stop_price=rec.stop_price,
                                    holding_days=rec.holding_days, entry_deadline=rec.valid_until)


# --- 리포트 지우기 ---

def test_owner_deletes_report_and_its_recommendation(api, user, fake):
    report = finished_report(user)
    rec = report_rec(report)
    listed = api.get("/api/reports").json()["results"]
    assert [r["canDelete"] for r in listed] == [True]
    assert api.get(f"/api/reports/{report.id}").json()["canDelete"] is True
    used = quota.usage(user).used

    assert api.delete(f"/api/reports/{report.id}").status_code == 204

    assert api.get("/api/reports").json() == {"count": 0, "results": []}
    for path in (f"/api/reports/{report.id}", f"/api/reports/{report.id}/pdf", f"/api/reports/{report.id}/events",
                 f"/api/recommendations/{rec.id}", f"/api/recommendations/{rec.id}/preview"):
        assert api.get(path).status_code == 404, path
    assert api.get("/api/recommendations?status=all").json()["count"] == 0
    assert api.delete(f"/api/reports/{report.id}").status_code == 404  # 이미 지움
    # 숨김일 뿐 행은 남아 한도·비용은 그대로 센다 (지워도 한도를 돌려받지 않는다)
    report.refresh_from_db()
    rec.refresh_from_db()
    assert report.deleted_at is not None and rec.deleted_at is not None
    assert quota.usage(user).used == used


def test_only_the_requester_deletes_a_finished_stock_report(api, user, django_user_model):
    bob, bob_api = login(django_user_model, "bob")
    mine = finished_report(user)
    running = finished_report(user, status=Report.RUNNING, finished_at=None)
    failed = finished_report(user, status=Report.FAILED)
    auto = finished_report(None, source=Report.AUTO)
    selection = finished_report(None, source=Report.AUTO, team=Report.STOCK_SELECTION, symbol="KR", name="KR")

    flags = {r["id"]: r["canDelete"] for r in api.get("/api/reports").json()["results"]}
    assert flags == {mine.id: True, running.id: False, failed.id: True, auto.id: False}
    assert {r["canDelete"] for r in bob_api.get("/api/reports").json()["results"]} == {False}

    denied = bob_api.delete(f"/api/reports/{mine.id}")
    assert denied.status_code == 403 and denied.json() == {"detail": hide.NOT_MY_REPORT}
    for other in (auto, selection):
        assert api.delete(f"/api/reports/{other.id}").json() == {"detail": hide.NOT_MY_REPORT}
    busy = api.delete(f"/api/reports/{running.id}")
    assert busy.status_code == 400 and busy.json() == {"detail": hide.NOT_FINISHED}
    assert api.delete(f"/api/reports/{failed.id}").status_code == 204
    assert Report.objects.filter(deleted_at__isnull=False).count() == 1


def test_live_plan_blocks_deleting_report_and_recommendation(api, user, fake, django_user_model):
    bob, bob_api = login(django_user_model, "bob")
    report = finished_report(user)
    rec = report_rec(report)
    plan = live_plan(rec, bob, TradePlan.HOLDING)

    for path in (f"/api/reports/{report.id}", f"/api/recommendations/{rec.id}"):
        blocked = api.delete(path)
        assert blocked.status_code == 400 and blocked.json() == {"detail": hide.LIVE_PLANS}
    assert not Report.objects.filter(deleted_at__isnull=False).exists()
    assert not Recommendation.objects.filter(deleted_at__isnull=False).exists()

    TradePlan.objects.filter(pk=plan.pk).update(status=TradePlan.CLOSED)  # 끝난 계획은 막지 않는다
    assert api.delete(f"/api/recommendations/{rec.id}").status_code == 204
    report.refresh_from_db()
    assert report.deleted_at is not None  # 리포트 추천을 지우면 출처 리포트도 숨긴다
    detail = bob_api.get(f"/api/trade-plans/{plan.id}")  # 끝난 계획의 상세는 그대로 열린다
    assert detail.status_code == 200 and detail.json()["recommendation"]["id"] == rec.id


def test_deleted_report_makes_no_recommendation(user, fake):
    report = finished_report(user, results={"report_agent": {"verdict": "buy", "oneLiner": "x",
                                                             "targets": {"entry": 69000, "target": 80000,
                                                                         "stop": 66000}}})
    Report.objects.filter(pk=report.pk).update(deleted_at=timezone.now())
    sources.collect(timezone.now(), lambda _: None)
    assert not Recommendation.objects.exists()


# --- 계획 제안 지우기 ---

def test_only_the_maker_deletes_a_recommendation(api, user, fake, django_user_model):
    bob, bob_api = login(django_user_model, "bob")
    rec = make_rec(requested_by=user)  # 분석 추천: 출처 리포트가 없다
    auto = make_rec(symbol="000660", name="SK하이닉스", entry=190000, target=230000, stop=180000)

    flags = {r["id"]: r["canDelete"] for r in api.get("/api/recommendations").json()["results"]}
    assert flags == {rec.id: True, auto.id: False}
    assert api.get(f"/api/recommendations/{rec.id}").json()["canDelete"] is True
    assert bob_api.get(f"/api/recommendations/{rec.id}").json()["canDelete"] is False

    denied = bob_api.delete(f"/api/recommendations/{rec.id}")
    assert denied.status_code == 403 and denied.json() == {"detail": hide.NOT_MY_RECOMMENDATION}
    assert api.delete(f"/api/recommendations/{auto.id}").status_code == 403
    assert api.delete(f"/api/recommendations/{rec.id}").status_code == 204
    assert [r["id"] for r in api.get("/api/recommendations?status=all").json()["results"]] == [auto.id]
    assert api.post(f"/api/recommendations/{rec.id}/activate", {}, format="json").status_code == 404
    assert api.delete(f"/api/recommendations/{rec.id}").status_code == 404


def test_activation_rechecks_deletion_under_lock(user, fake):
    """화면이 추천을 읽은 뒤 지워지면 활성화가 계획을 만들지 않는다 (executor._start가 추천 행을 잠그고 본다)."""
    rec = make_rec(requested_by=user)
    Recommendation.objects.filter(pk=rec.pk).update(deleted_at=timezone.now())
    with pytest.raises(NotFound):
        executor.activate(rec, user, 1_000_000)
    assert not TradePlan.objects.exists()


# --- 가격이 지난 추천 자동 정리 ---

def test_invalidate_expires_recommendations_whose_price_passed(api, user, fake):
    below = make_rec()  # 손절 66,000
    above = make_rec(symbol="000660", name="SK하이닉스", entry=190000, target=230000, stop=180000)
    inside = make_rec(symbol="005935", name="삼성전자우", entry=59000, target=70000, stop=55000)
    gone = make_rec(symbol="005930", requested_by=user)
    Recommendation.objects.filter(pk=gone.pk).update(deleted_at=timezone.now())
    set_price(fake, "005930", 65000)
    set_price(fake, "000660", 231000)

    assert sources.invalidate(timezone.now()) == 2

    status = {r.id: (r.status, r.expired_reason) for r in Recommendation.objects.all()}
    assert status[below.id] == ("expired", "below_stop")
    assert status[above.id] == ("expired", "above_target")
    assert status[inside.id] == ("open", None)
    assert status[gone.id] == ("open", None)  # 지운 추천은 보지 않는다
    assert [r["id"] for r in api.get("/api/recommendations").json()["results"]] == [inside.id]
    body = api.get(f"/api/recommendations/{below.id}").json()
    assert body["status"] == "expired" and body["expiredReason"] == "below_stop" and "expired" in body["blockedBy"]
    assert api.get(f"/api/recommendations/{inside.id}").json()["expiredReason"] is None

    set_price(fake, "005930", 70000)  # 가격이 돌아와도 다시 open으로 돌리지 않는다
    assert sources.invalidate(timezone.now(), force=True) == 0
    assert Recommendation.objects.get(pk=below.id).status == "expired"


def test_invalidate_runs_once_a_minute_and_skips_without_prices(fake, monkeypatch):
    rec = make_rec()
    now = timezone.now()
    assert sources.invalidate(now) == 0
    set_price(fake, "005930", 65000)
    assert sources.invalidate(now + timedelta(seconds=30)) == 0  # 1분 안에는 다시 보지 않는다
    fake.fail = True  # 증권사 조회 실패 → 다음 번에
    assert sources.invalidate(now + timedelta(seconds=61)) == 0
    fake.fail = False
    assert sources.invalidate(now + timedelta(seconds=122)) == 1
    assert Recommendation.objects.get(pk=rec.pk).expired_reason == "below_stop"


def test_collect_logs_invalidated_and_deadline_reason(fake):
    old = make_rec()
    passed = make_rec(symbol="000660", name="SK하이닉스", entry=190000, target=230000, stop=180000)
    Recommendation.objects.filter(pk=old.pk).update(valid_until=timezone.now() - timedelta(minutes=1))
    set_price(fake, "000660", 170000)
    lines = []
    sources.collect(timezone.now(), lines.append)
    assert Recommendation.objects.get(pk=old.pk).expired_reason == "deadline"
    assert Recommendation.objects.get(pk=passed.pk).expired_reason == "below_stop"
    assert any("가격이 이미 손절가·목표가를 지난 추천 1개" in line for line in lines)


def test_expired_reason_of_rows_the_loop_has_not_updated(api, fake):
    rec = make_rec()
    Recommendation.objects.filter(pk=rec.pk).update(valid_until=timezone.now() - timedelta(minutes=1))
    body = api.get(f"/api/recommendations/{rec.id}").json()
    assert body["status"] == "expired" and body["expiredReason"] == "deadline"
