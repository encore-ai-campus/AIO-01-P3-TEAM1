"""알림 API (docs/API.md "AI 추천 · 매매 계획 · 자동매매 · 알림"). config/urls.py가 api/ 아래에 include한다. 끝 슬래시 없음."""
from django.urls import path

from notifications import views

urlpatterns = [
    path("notifications", views.NotificationListView.as_view(), name="notifications"),
    path("notifications/read", views.NotificationReadView.as_view(), name="notifications-read"),
    path("notification-settings", views.NotificationSettingsView.as_view(), name="notification-settings"),
    path("notification-settings/test", views.NotificationTestView.as_view(), name="notification-settings-test"),
]
