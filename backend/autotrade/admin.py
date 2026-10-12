"""관리 화면: 추천·계획·사건은 보기 위주 (바꾸기는 executor가 한다)."""
from django.contrib import admin

from .models import PlanEvent, Recommendation, TradePlan


class ReadOnly(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(Recommendation)
class RecommendationAdmin(ReadOnly):
    list_display = ("id", "source", "name", "symbol", "entry_price", "target_price", "stop_price", "reward_risk",
                    "status", "expired_reason", "valid_until", "created_at", "deleted_at")
    list_filter = ("source", "status", "expired_reason", "market")
    search_fields = ("symbol", "name")


class PlanEventInline(admin.TabularInline):
    model = PlanEvent
    extra = 0
    can_delete = False
    readonly_fields = ("step", "kind", "message", "details", "at")

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(TradePlan)
class TradePlanAdmin(ReadOnly):
    list_display = ("id", "user", "name", "symbol", "status", "via", "manual_start", "quantity", "budget_mode",
                    "budget_krw", "order", "pnl_krw", "activated_at")
    list_filter = ("status", "via", "manual_start", "budget_mode")  # manual_start: 시연용 수동 시작 계획 (DECISIONS 31장)
    search_fields = ("symbol", "name", "user__username")
    inlines = [PlanEventInline]


@admin.register(PlanEvent)
class PlanEventAdmin(ReadOnly):
    list_display = ("plan", "step", "kind", "message", "at")
    list_filter = ("kind",)
