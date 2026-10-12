"""장애 주입 실행 source "chaos" (docs/DECISIONS.md 35장, docs/plans/장애주입분리계획.md 8장 C3·C4).

1. Report.source의 선택지에 "chaos"를 더한다 (선택지만 바뀐다 — DB 열은 그대로).
2. 이미 있는 장애 주입 리포트(팀원이 서비스 화면에서 chaos.enabled를 켜고 신청한 것)를 source "chaos"로 옮겨 서비스에서 숨긴다.
   user는 그대로 둔다 (숨김은 source로 한다). 관리 서버에서는 그대로 보인다.
   JSON 열은 Python에서 읽는다 (SQLite와 PostgreSQL에서 같게 — JSON 조회 문법을 쓰지 않는다).

되돌리기: "chaos" 행을 신청자가 있으면 "user", 없으면(내부 API로 만든 실행) "auto"로 돌린다 —
이 선택지를 모르는 이전 코드가 모르는 source 값을 만나지 않게. 옛 장애 주입 리포트는 원래 값(user)으로 돌아간다.
"""
from django.db import migrations, models

CHAOS = "chaos"


def chaos_reports_to_chaos_source(apps, schema_editor):
    Report = apps.get_model("reports", "Report")
    ids = [report.pk for report in Report.objects.exclude(source=CHAOS).only("id", "chaos").iterator()
           if isinstance(report.chaos, dict) and report.chaos.get("enabled") is True]
    if ids:
        Report.objects.filter(pk__in=ids).update(source=CHAOS)


def chaos_source_back(apps, schema_editor):
    Report = apps.get_model("reports", "Report")
    Report.objects.filter(source=CHAOS, user__isnull=False).update(source="user")
    Report.objects.filter(source=CHAOS, user__isnull=True).update(source="auto")


class Migration(migrations.Migration):

    dependencies = [
        ('reports', '0004_report_deleted_at'),
    ]

    operations = [
        migrations.AlterField(
            model_name='report',
            name='source',
            field=models.CharField(choices=[('user', 'user'), ('auto', 'auto'), ('chaos', 'chaos')], db_default='user', default='user', max_length=8),
        ),
        migrations.RunPython(chaos_reports_to_chaos_source, chaos_source_back),
    ]
