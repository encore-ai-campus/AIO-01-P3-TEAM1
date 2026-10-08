from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("trading", "0003_remove_day_style"),
    ]

    operations = [
        migrations.CreateModel(
            name="EngineStatus",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=32, unique=True)),
                ("version", models.CharField(max_length=64)),
                ("host", models.CharField(max_length=128)),
                ("pid", models.IntegerField()),
                ("started_at", models.DateTimeField()),
                ("beat_at", models.DateTimeField()),
                ("halted", models.BooleanField(default=False)),
                ("broker_ready", models.BooleanField(default=False)),
                ("last_tick_ms", models.IntegerField(blank=True, null=True)),
                ("step_errors", models.JSONField(blank=True, default=list)),
                ("limits", models.JSONField(blank=True, default=dict)),
            ],
            options={
                "db_table": "engine_status",
            },
        ),
    ]
