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

REST_FRAMEWORK = {
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Paper Trading API",
    "VERSION": "0.1.0",
}
