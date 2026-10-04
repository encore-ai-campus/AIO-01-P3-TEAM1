"""AI 추천·매매 계획 API (docs/API.md "AI 추천 · 매매 계획 · 자동매매 · 알림"). config/urls.py가 api/ 아래에 include한다. 끝 슬래시 없음."""
from django.urls import path

from . import views

urlpatterns = [
    path("recommendations", views.RecommendationsView.as_view()),
    path("recommendations/demo", views.DemoRecommendationView.as_view()),
    path("recommendations/<int:rec_id>", views.RecommendationView.as_view()),
    path("recommendations/<int:rec_id>/preview", views.RecommendationPreviewView.as_view()),
    path("recommendations/<int:rec_id>/activate", views.RecommendationActivateView.as_view()),
    path("trade-plans", views.TradePlansView.as_view()),
    path("trade-plans/<int:plan_id>", views.TradePlanView.as_view()),
    path("trade-plans/<int:plan_id>/cancel", views.TradePlanCancelView.as_view()),
]
