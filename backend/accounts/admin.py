"""관리자 화면: 사용자 화면에 프로필(닉네임·공개 여부)을 붙이고, 프로필 목록도 따로 둔다."""
from django import forms
from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin

from accounts.models import Profile, clean_nickname, nickname_error

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


class TeamUserAdmin(UserAdmin):
    list_display = (*UserAdmin.list_display, "nickname", "is_public")
    list_select_related = ("profile",)

    def get_inlines(self, request, obj):
        # 사용자를 만들 때는 신호가 프로필을 만들므로 인라인을 숨긴다 (같이 만들면 겹친다). 저장 뒤 수정 화면에서 고친다.
        return [ProfileInline] if obj is not None else []

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


if admin.site.is_registered(User):
    admin.site.unregister(User)
admin.site.register(User, TeamUserAdmin)
