# 관리 서버의 관리자 API(기본 CMD, uvicorn 8100)와 MCP 서버(compose가 command를 `python -m paper_admin.mcp_server`로 바꾼다).
# 빌드 컨텍스트: server/. HEALTHCHECK는 compose가 정한다.
FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv

ENV TZ=Asia/Seoul \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH" \
    ADMIN_DATA_DIR=/data

WORKDIR /app

# 의존성 먼저 (코드만 바뀌면 이 층을 다시 쓴다)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY paper_admin ./paper_admin
RUN uv sync --frozen --no-dev \
    && groupadd --system --gid 10001 admin \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin admin \
    && mkdir -p /data && chown 10001:10001 /data && chmod 0700 /data

USER 10001:10001
EXPOSE 8100 8101

CMD ["uvicorn", "paper_admin.api:app", "--host", "0.0.0.0", "--port", "8100", "--workers", "1", "--no-server-header"]
