from django.contrib import admin

from .models import AnalysisRun, Job, RunFile


@admin.register(AnalysisRun)
class AnalysisRunAdmin(admin.ModelAdmin):
    list_display = ("id", "analyzed_at", "symbol", "name", "verdict", "scenario_count", "requested_by", "cost_usd",
                    "run_file")
    list_filter = ("verdict", "market")
    search_fields = ("symbol", "name", "run_file", "requested_by")
    ordering = ("-analyzed_at",)


@admin.register(Job)
class JobAdmin(admin.ModelAdmin):
    list_display = ("id", "type", "user", "payload", "status", "created_at", "started_at", "finished_at")
    list_filter = ("status", "type")
    search_fields = ("user__username",)
    ordering = ("-created_at",)


@admin.register(RunFile)
class RunFileAdmin(admin.ModelAdmin):
    list_display = ("name", "ok", "size", "indexed_at")
    list_filter = ("ok",)
    search_fields = ("name",)
