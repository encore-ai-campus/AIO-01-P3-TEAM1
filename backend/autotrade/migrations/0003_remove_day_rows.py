"""단타 연습 기능 삭제 (2026-10-06) — 데이터 정리. 열은 다음 마이그레이션(0004)이 지운다.

horizon="DAY"이거나 단타 연습 추천(source="day")에서 나온 계획을 지우고 (PlanEvent는 CASCADE), 그 계획을 가리키던 알림
(link == "/plans/<id>")과 단타 화면(link가 "/day"로 시작)을 가리키던 알림, 단타 연습 추천을 지운다 (추천은 PROTECT라 계획 먼저).
열을 지우는 작업과 나눈 까닭: PostgreSQL은 행을 지운 같은 트랜잭션에서 그 표를 ALTER하면 "pending trigger events"로 막는다.
되돌리기는 하지 않는다 (지운 행은 돌아오지 않는다).
"""
from django.db import migrations
from django.db.models import Q

CHUNK = 500  # IN 목록 한 번의 크기 (SQLite 변수 수 제한 아래)


def remove_day_rows(apps, schema_editor):
    Recommendation = apps.get_model("autotrade", "Recommendation")
    TradePlan = apps.get_model("autotrade", "TradePlan")
    Notification = apps.get_model("notifications", "Notification")
    ids = list(TradePlan.objects.filter(Q(horizon="DAY") | Q(recommendation__source="day"))
               .values_list("id", flat=True))
    for start in range(0, len(ids), CHUNK):
        chunk = ids[start:start + CHUNK]
        Notification.objects.filter(link__in=[f"/plans/{plan_id}" for plan_id in chunk]).delete()
        TradePlan.objects.filter(id__in=chunk).delete()
    Notification.objects.filter(link__startswith="/day").delete()
    Recommendation.objects.filter(source="day").delete()


class Migration(migrations.Migration):

    dependencies = [
        ('autotrade', '0002_horizon'),
        ('notifications', '0002_outbox_sending'),
    ]

    operations = [
        migrations.RunPython(remove_day_rows, migrations.RunPython.noop),
    ]
