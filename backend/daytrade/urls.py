"""단타 연습 API (docs/API.md "단타 연습"). config/urls.py가 api/ 아래에 include한다. 끝 슬래시 없음.

모델이 없다 — 단타 계획은 autotrade의 추천·계획(source day, horizon DAY)을 재사용한다.
분봉(GET /api/stocks/{symbol}/minute-candles)은 trading 앱에 있다.
"""
from django.urls import path

from . import views

urlpatterns = [
    path("day/status", views.DayStatusView.as_view()),
    path("day/preview", views.DayPreviewView.as_view()),
    path("day/plans", views.DayPlansView.as_view()),
    path("day/review", views.DayReviewView.as_view()),
]
