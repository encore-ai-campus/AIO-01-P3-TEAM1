"""관리자 화면: 사용자 화면에 프로필(닉네임·공개 여부)과 투자자 프로필(읽기 전용)을 붙이고, 각 목록도 따로 둔다.

투자자 프로필은 점수·단계·주린이모드·진단 시각만 보인다 (진단 답 원문은 보이지 않는다). 관리자 화면에서 고치지 않는다 —
값은 본인이 API로만 바꾼다 (docs/API.md "투자자 프로필과 주린이모드"). 지우면 기본값(주린이모드 켬·진단 전)으로 돌아간다.
"""
from django import forms
from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin

from accounts.assessment import EXPERIENCE_LEVEL_LABELS, RISK_PROFILE_LABELS
from accounts.models import InvestorProfile, Profile, clean_nickname, nickname_error

User = get_user_model()


class ProfileForm(forms.ModelForm):
    """API와 같은 닉네임 규칙 (2~12자, 다른 사람의 닉네임·아이디와 대소문자 무시하고 겹치지 않음)."""

    class Meta:
        model = Profile
        fields = ("nickname", "is_public")

    def clean_nickname(self):
        nickname = clean_nickname(self.cleaned_data["nickname"])
        error = nickname_error(nickname, self.instance.user if self.instance.user_id else None)
        if error:
            raise forms.ValidationError(error)
        return nickname


class ProfileInline(admin.StackedInline):
    model = Profile
    form = ProfileForm
    can_delete = False
    max_num = 1
    verbose_name_plural = "프로필"


def _labeled(code, labels: dict) -> str | None:
    return f"{labels.get(code, code)} ({code})" if code else None


class InvestorProfileDisplay:
    """투자자 프로필 읽기 전용 칸 (인라인과 목록이 같이 쓴다)."""
    investor_fields = ("beginner_mode", "experience_score", "experience", "risk_score", "risk",
                       "recommended_beginner_mode", "assessed_at", "updated_at")

    @admin.display(description="경험 단계", ordering="experience_level")
    def experience(self, obj):
        return _labeled(obj.experience_level, EXPERIENCE_LEVEL_LABELS)

    @admin.display(description="투자 성향", ordering="risk_profile")
    def risk(self, obj):
        return _labeled(obj.risk_profile, RISK_PROFILE_LABELS)

    def has_add_permission(self, request, obj=None):
        return False  # 본인이 진단·스위치로 만든다

    def has_change_permission(self, request, obj=None):
        return False  # 읽기 전용


class InvestorProfileInline(InvestorProfileDisplay, admin.StackedInline):
    model = InvestorProfile
    fields = InvestorProfileDisplay.investor_fields
    readonly_fields = InvestorProfileDisplay.investor_fields
    can_delete = False
    max_num = 1
    verbose_name = verbose_name_plural = "투자자 프로필 (읽기 전용, 없으면 주린이모드 켬·진단 전)"


class TeamUserAdmin(UserAdmin):
    list_display = (*UserAdmin.list_display, "nickname", "is_public")
    list_select_related = ("profile",)

    def get_inlines(self, request, obj):
        # 사용자를 만들 때는 신호가 프로필을 만들므로 인라인을 숨긴다 (같이 만들면 겹친다). 저장 뒤 수정 화면에서 고친다.
        return [ProfileInline, InvestorProfileInline] if obj is not None else []

    @admin.display(description="닉네임", ordering="profile__nickname")
    def nickname(self, obj):
        return getattr(getattr(obj, "profile", None), "nickname", None)

    @admin.display(description="공개", boolean=True, ordering="profile__is_public")
    def is_public(self, obj):
        return getattr(getattr(obj, "profile", None), "is_public", None)


@admin.register(Profile)
class ProfileAdmin(admin.ModelAdmin):
    form = ProfileForm
    fields = ("user", "nickname", "is_public")
    readonly_fields = ("user",)
    list_display = ("nickname", "user", "is_public")
    list_filter = ("is_public",)
    search_fields = ("nickname", "user__username")
    list_select_related = ("user",)

    def has_add_permission(self, request):
        return False  # 프로필은 사용자를 만들면 자동으로 생긴다


@admin.register(InvestorProfile)
class InvestorProfileAdmin(InvestorProfileDisplay, admin.ModelAdmin):
    fields = ("user", *InvestorProfileDisplay.investor_fields)
    readonly_fields = fields
    list_display = ("user", "beginner_mode", "experience", "risk", "assessed_at")
    list_filter = ("beginner_mode", "experience_level", "risk_profile")
    search_fields = ("user__username",)
    list_select_related = ("user",)


if admin.site.is_registered(User):
    admin.site.unregister(User)
admin.site.register(User, TeamUserAdmin)
