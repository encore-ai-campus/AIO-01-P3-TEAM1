"""Django 설정. 값은 환경 변수가 우선이고, 없으면 저장소 루트의 .env에서 읽는다."""
import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured
from paper_engine.config import ROOT, load_env

BASE_DIR = Path(__file__).resolve().parent.parent

_ENV = load_env(ROOT / ".env")


def env(key: str, default: str = "") -> str:
    return os.environ.get(key) or _ENV.get(key) or default


DEBUG = env("DJANGO_DEBUG", "off").lower() in ("on", "true", "1", "yes")

SECRET_KEY = env("DJANGO_SECRET_KEY")
if not SECRET_KEY:
    # 개발용 기본 키는 로컬 개발 환경(DEBUG이고 SQLite)에서만 쓴다. EC2(PostgreSQL)는 DEBUG여도 키가 있어야 뜬다.
    if not DEBUG or env("POSTGRES_HOST"):
        raise ImproperlyConfigured("DJANGO_SECRET_KEY가 필요합니다 (로컬 개발 환경: DJANGO_DEBUG=on이고 POSTGRES_HOST가 "
                                   "비어 있을 때만 개발용 기본값을 씁니다).")
    SECRET_KEY = "dev-only-insecure-secret-key-do-not-use-in-production"

ALLOWED_HOSTS = [h.strip() for h in env("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if h.strip()]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "drf_spectacular",
    "accounts",
    "trading",
    "analysis",
    "reports",
    "autotrade",
    "notifications",
    "longterm",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

# POSTGRES_HOST가 비어 있으면 개발용 SQLite를 쓴다.
if env("POSTGRES_HOST"):
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": env("POSTGRES_DB"),
            "USER": env("POSTGRES_USER"),
            "PASSWORD": env("POSTGRES_PASSWORD"),
            "HOST": env("POSTGRES_HOST"),
            "PORT": env("POSTGRES_PORT", "5432"),
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "ko-kr"
TIME_ZONE = "Asia/Seoul"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# DEBUG가 꺼지면 Django 기본 설정은 콘솔 로그를 끄고 관리자 메일(ADMINS 없음)로만 보내서, 500 오류의 traceback이 docker logs에
# 남지 않는다. 운영(DEBUG=off)에서도 요청 오류(ERROR 이상)를 콘솔로 낸다. DEBUG일 때는 Django 기본 콘솔 핸들러가 이미 내므로 겹치지 않게 막는다.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"require_debug_false": {"()": "django.utils.log.RequireDebugFalse"}},
    "handlers": {
        "console_errors": {"class": "logging.StreamHandler", "level": "ERROR", "filters": ["require_debug_false"]},
    },
    "loggers": {"django.request": {"handlers": ["console_errors"]}},
}

# API 공통 규칙은 docs/API.md. 세션 로그인 + CSRF, JSON만, 오류는 {"detail": ...} (config/api.py).
REST_FRAMEWORK = {
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "EXCEPTION_HANDLER": "config.api.exception_handler",
    "DEFAULT_THROTTLE_RATES": {"login": "10/min"},  # 로그인 시도 (주소별)
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Paper Trading API",
    "VERSION": "0.1.0",
    # 로그인 없이 되는 것은 로그인·csrf·health뿐이다 (docs/API.md). CI는 `manage.py spectacular`로 만든다.
    "SERVE_PERMISSIONS": ["rest_framework.permissions.IsAuthenticated"],
}

# 시세 캐시(trading/market.py)와 로그인 시도 제한이 쓴다. 프로세스별 메모리 캐시라 웹 프로세스와 run_engine이 값을 같이 쓰지 않는다.
# 기본 300개는 종목이 수십 개만 돼도 밀려나므로 늘린다. 운영에서 프로세스를 여럿 띄우면 Redis 캐시로 바꾼다 (4E).
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "OPTIONS": {"MAX_ENTRIES": 20000},
    }
}
