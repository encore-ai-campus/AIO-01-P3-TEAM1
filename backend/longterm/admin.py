"""관리 화면: 오늘의 내 종목 뉴스·산 이유·점검은 보기 위주 (만들기·바꾸기는 jobs·API가 한다)."""
from django.contrib import admin

from .models import DailyMoveNote, InvestmentThesis, ThesisCheck


class ReadOnly(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(DailyMoveNote)
class DailyMoveNoteAdmin(ReadOnly):
    list_display = ("day", "name", "symbol", "change_rate", "excess_change_rate", "method", "uncertain", "cost_usd",
                    "created_at")
    list_filter = ("method", "uncertain", "day")
    search_fields = ("symbol", "name")


class ThesisCheckInline(admin.TabularInline):
    model = ThesisCheck
    extra = 0
    can_delete = False
    fields = ("checked_at", "trigger", "period", "overall", "previous_overall", "new_bad", "notified")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(InvestmentThesis)
class InvestmentThesisAdmin(ReadOnly):
    list_display = ("id", "user", "name", "symbol", "active", "baseline_period", "updated_at")
    list_filter = ("active", "market")
    search_fields = ("symbol", "name", "user__username")
    inlines = [ThesisCheckInline]


@admin.register(ThesisCheck)
class ThesisCheckAdmin(ReadOnly):
    list_display = ("thesis", "checked_at", "trigger", "overall", "previous_overall", "notified")
    list_filter = ("trigger", "overall", "notified")
