"""autotrade 0003·0004 (단타 기능 삭제): 단타 계획·추천과 그 알림을 지우고 horizon 열을 지운다. 다른 행은 그대로."""
from datetime import UTC, datetime

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

from autotrade.models import Recommendation, TradePlan

BEFORE = [("autotrade", "0002_horizon"), ("notifications", "0002_outbox_sending")]
AFTER = [("autotrade", "0004_remove_horizon")]
AT = datetime(2026, 10, 5, 1, 0, tzinfo=UTC)


@pytest.mark.django_db(transaction=True)
def test_day_rows_and_their_notifications_are_removed():
    migrator = MigrationExecutor(connection)
    migrator.migrate(BEFORE)
    old = migrator.loader.project_state(BEFORE).apps
    Rec, Plan = old.get_model("autotrade", "Recommendation"), old.get_model("autotrade", "TradePlan")
    Event, Note = old.get_model("autotrade", "PlanEvent"), old.get_model("notifications", "Notification")
    user = old.get_model("auth", "User").objects.create(username="old-alice")
    prices = dict(symbol="005930", name="삼성전자", market="KR", currency="KRW", entry_price=69000, target_price=72000,
                  stop_price=67000)
    rec_values = dict(**prices, probability=0.5, target_return=0.04, stop_loss_rate=-0.03, reward_risk=2.0,
                      expected_return=0.01, summary="", valid_until=AT)
    swing_rec = Rec.objects.create(source="analysis", holding_days=10, horizon="SWING", **rec_values)
    day_rec = Rec.objects.create(source="day", holding_days=1, horizon="DAY", requested_by=user, **rec_values)
    plan_values = dict(user=user, quantity=1, entry_deadline=AT, **prices)
    swing = Plan.objects.create(recommendation=swing_rec, holding_days=10, **plan_values)
    day = Plan.objects.create(recommendation=day_rec, holding_days=1, horizon="DAY", status="closed", **plan_values)
    for plan in (swing, day):
        Event.objects.create(plan=plan, step=1, kind="activated", message="웹에서 계획 활성화")
    links = [f"/plans/{swing.pk}", f"/plans/{day.pk}", "/day", "/day/review", f"/recommendations/{swing_rec.pk}", None]
    for link in links:
        Note.objects.create(user=user, kind="system", title="알림", link=link)
    try:
        migrator = MigrationExecutor(connection)
        migrator.migrate(AFTER)
        new = migrator.loader.project_state(AFTER).apps
        assert list(new.get_model("autotrade", "Recommendation").objects.values_list("pk", flat=True)) == [swing_rec.pk]
        assert list(new.get_model("autotrade", "TradePlan").objects.values_list("pk", flat=True)) == [swing.pk]
        assert list(new.get_model("autotrade", "PlanEvent").objects.values_list("plan_id", flat=True)) == [swing.pk]
        remaining = set(new.get_model("notifications", "Notification").objects.values_list("link", flat=True))
        assert remaining == {f"/plans/{swing.pk}", f"/recommendations/{swing_rec.pk}", None}
    finally:
        migrator = MigrationExecutor(connection)
        migrator.migrate(migrator.loader.graph.leaf_nodes())
    fields = {f.name for f in Recommendation._meta.get_fields()} | {f.name for f in TradePlan._meta.get_fields()}
    assert "horizon" not in fields
    assert [s for s, _ in Recommendation.SOURCES] == ["report", "analysis", "demo"]
