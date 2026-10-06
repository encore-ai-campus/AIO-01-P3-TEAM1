"""장기투자 API (docs/API.md "장기투자"). config/urls.py가 api/ 아래에 include한다. 끝 슬래시 없음.

stocks/<symbol>/fundamentals는 trading의 stocks/<symbol>(슬래시 없는 한 단계)와 겹치지 않는다.
"""
from django.urls import path

from . import views

urlpatterns = [
    path("longterm/daily-moves", views.DailyMovesView.as_view()),
    path("longterm/daily-moves/<str:symbol>", views.DailyMoveView.as_view()),
    path("longterm/theses", views.ThesesView.as_view()),
    path("longterm/theses/<str:symbol>", views.ThesisView.as_view()),
    path("stocks/<str:symbol>/fundamentals", views.FundamentalsView.as_view()),
]
