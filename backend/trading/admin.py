from django.contrib import admin

from .models import EquityDaily, PaperAccount, PaperFill, PaperOrder, Reservation


@admin.register(PaperAccount)
class PaperAccountAdmin(admin.ModelAdmin):
    list_display = ("id", "name", "user", "initial_capital_krw", "cash_krw", "created_at")
    search_fields = ("name", "user__username")


@admin.register(PaperOrder)
class PaperOrderAdmin(admin.ModelAdmin):
    list_display = ("id", "account", "symbol", "name", "style", "order_type", "quantity", "status", "fill_price",
                    "exit_price", "exit_reason", "pnl_krw", "created_at")
    list_filter = ("status", "style", "market", "order_type", "exit_reason")
    search_fields = ("symbol", "name", "account__name", "requested_by")


@admin.register(PaperFill)
class PaperFillAdmin(admin.ModelAdmin):
    list_display = ("id", "account", "order", "side", "price", "quantity", "commission", "tax", "cash_change_krw",
                    "reason", "filled_at")
    list_filter = ("side", "reason")


@admin.register(EquityDaily)
class EquityDailyAdmin(admin.ModelAdmin):
    list_display = ("account", "day", "cash_krw", "holdings_value_krw", "equity_krw", "recorded_at")
    list_filter = ("day",)


@admin.register(Reservation)
class ReservationAdmin(admin.ModelAdmin):
    list_display = ("id", "account", "kind", "symbol", "name", "style", "quantity", "order", "created_at")
    list_filter = ("kind", "style", "market")
