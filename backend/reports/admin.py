from django.contrib import admin

from .models import Report, TraceEvent

# Shared State와 Trace는 Orchestrator가 reports.orchestration.state로만 바꾼다. 관리자 화면은 보기와 지우기만 한다.
STATE_FIELDS = ("status", "current_step", "results", "errors", "completed_agents", "failed_agents", "content",
                "started_at", "finished_at")
TRACE_FIELDS = ("step", "actor", "action", "status", "provider", "model", "latency_ms", "details", "at")


class TraceEventInline(admin.TabularInline):
    model = TraceEvent
    fields = readonly_fields = TRACE_FIELDS
    ordering = ("step",)
    extra = 0
    can_delete = False

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(Report)
class ReportAdmin(admin.ModelAdmin):
    list_display = ("id", "created_at", "team", "symbol", "name", "market", "status", "current_step", "source", "user",
                    "started_at", "finished_at", "deleted_at")
    list_filter = ("team", "status", "source", "market")
    search_fields = ("symbol", "name", "user__username")
    ordering = ("-created_at",)
    readonly_fields = STATE_FIELDS
    inlines = [TraceEventInline]


@admin.register(TraceEvent)
class TraceEventAdmin(admin.ModelAdmin):
    list_display = ("report", "step", "actor", "action", "status", "provider", "model", "latency_ms", "at")
    list_filter = ("status", "actor")
    search_fields = ("report__symbol", "actor", "action")
    ordering = ("-report_id", "step")
    readonly_fields = ("report", *TRACE_FIELDS)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
