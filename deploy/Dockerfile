# syntax=docker/dockerfile:1
# 앱 이미지: Django(web)와 엔진 루프(engine)가 같은 바탕을 쓴다. 빌드 컨텍스트는 저장소 루트.
#   docker build -f deploy/Dockerfile --target web .
#   docker build -f deploy/Dockerfile --target engine .
FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Seoul \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    PAPER_ROOT=/data

# 엔진은 호스트 시간대가 KST라고 가정한다 (docs/DECISIONS.md 1장). 실행은 root가 아닌 app 사용자로 한다.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --home-dir /home/app --create-home --shell /usr/sbin/nologin app \
    && mkdir -p /data /app/backend/staticfiles \
    && chown -R app:app /data /app

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv

WORKDIR /app
# 의존성 먼저 (소스가 바뀌어도 이 층은 다시 받지 않는다). uv 작업 공간이라 멤버의 pyproject.toml도 필요하다.
COPY pyproject.toml uv.lock ./
COPY engine/pyproject.toml engine/pyproject.toml
COPY backend/pyproject.toml backend/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace

COPY engine/ engine/
COPY backend/ backend/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

WORKDIR /app/backend


# --- web: Django + gunicorn ---
FROM base AS web
USER app
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"]
# --no-control-socket: gunicorn 26의 제어 소켓이 기본으로 ~/.gunicorn에 만들어지는데 읽기 전용 파일시스템이라 시작 때마다
# "Control server error: [Errno 30] Read-only file system" 오류가 난다 (OPS-9). 쓰지 않는 기능이라 끈다.
# 워커는 프로세스 하나에 스레드 여러 개로 띄운다: 시세 캐시와 증권사 호출 간격 조절이 프로세스별이라 프로세스를 늘리면
# 증권사 호출이 그만큼 늘고(docs/DECISIONS.md 8-6), SSE 연결은 스레드 하나를 60초까지 잡는다 (9-4).
CMD ["sh", "-c", "python manage.py collectstatic --noinput && exec gunicorn config.wsgi:application --bind 0.0.0.0:8000 --worker-class gthread --workers 1 --threads 16 --timeout 120 --worker-tmp-dir /dev/shm --no-control-socket --access-logfile -"]


# --- engine: run_engine 루프 (체결·청산·예약·일별 자산·AI 작업). 리포트 PDF용 Chromium과 한글 글꼴을 넣는다 ---
FROM base AS engine
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && printf '%s\n' '#!/bin/sh' \
       '# 컨테이너 안에서는 Chromium 자체 샌드박스를 쓸 수 없다 (권한을 모두 뺀 non-root 컨테이너가 격리를 맡는다).' \
       'exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@"' > /usr/local/bin/chrome-headless \
    && chmod +x /usr/local/bin/chrome-headless
ENV CHROME_BIN=/usr/local/bin/chrome-headless \
    HOME=/tmp
USER app
CMD ["python", "manage.py", "run_engine"]
