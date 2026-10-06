"""계정 API (docs/API.md). config/urls.py가 api/ 아래에 include한다. 경로에 끝 슬래시를 붙이지 않는다."""
from django.urls import path

from accounts import views

urlpatterns = [
    path("auth/csrf", views.CsrfView.as_view(), name="auth-csrf"),
    path("auth/login", views.LoginView.as_view(), name="auth-login"),
    path("auth/logout", views.LogoutView.as_view(), name="auth-logout"),
    path("auth/me", views.MeView.as_view(), name="auth-me"),
    path("me/profile", views.ProfileView.as_view(), name="me-profile"),
    path("me/investor-profile", views.InvestorProfileView.as_view(), name="me-investor-profile"),
]
