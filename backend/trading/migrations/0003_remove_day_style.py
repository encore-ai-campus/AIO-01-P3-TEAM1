"""단타 연습 기능 삭제 (2026-10-06) — 보유 방식 style "day" 주문 정리 (docs/API.md "보유 방식": swing | long).

체결 대기(ENTRY_PENDING)인 단타 주문은 취소하고 (엔진 취소와 같은 열: status·closed_at·note), 모든 단타 주문의 style을 swing으로
바꾼다 (보유 중이던 주문은 목표·손절로 자동 매도되는 스윙 주문이 된다). style 열 자체는 그대로 둔다. 되돌리기는 하지 않는다.
예약(Reservation)은 단타 주문을 받지 않았으므로 바꿀 것이 없다.
"""
from django.db import migrations
from django.utils import timezone

NOTE = "단타 기능 삭제"


def remove_day_style(apps, schema_editor):
    PaperOrder = apps.get_model("trading", "PaperOrder")
    day = PaperOrder.objects.filter(style="day")
    day.filter(status="ENTRY_PENDING").update(status="CANCELED", closed_at=timezone.now(), note=NOTE)
    day.update(style="swing")


class Migration(migrations.Migration):

    dependencies = [
        ('trading', '0002_order_style'),
    ]

    operations = [
        migrations.RunPython(remove_day_style, migrations.RunPython.noop),
    ]
