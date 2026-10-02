"""모의 트레이딩 API (docs/API.md). config/urls.py가 api/ 아래에 include한다. 경로에 끝 슬래시를 붙이지 않는다."""
from django.urls import path

from . import views

urlpatterns = [
    path("market", views.MarketView.as_view()),
    path("stocks/search", views.StockSearchView.as_view()),
    path("stocks/<str:symbol>", views.StockDetailView.as_view()),
    path("quotes", views.QuotesView.as_view()),
    path("account", views.AccountView.as_view()),
    path("account/equity", views.EquityView.as_view()),
    path("orders", views.OrdersView.as_view()),
    path("orders/<int:order_id>", views.OrderView.as_view()),
    path("orders/<int:order_id>/sell", views.OrderSellView.as_view()),
    path("orders/<int:order_id>/cancel", views.OrderCancelView.as_view()),
    path("fills", views.FillsView.as_view()),
    path("reservations", views.ReservationsView.as_view()),
    path("reservations/<int:reservation_id>", views.ReservationView.as_view()),
    path("ranking", views.RankingView.as_view()),
]
