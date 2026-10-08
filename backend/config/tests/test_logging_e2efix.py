"""운영(DJANGO_DEBUG=off)에서도 500 오류의 traceback이 콘솔(docker logs)에 남는다 (OPS-1: 운영 DEBUG를 끄면서 생기는 빈틈)."""
import io
import logging
from contextlib import redirect_stderr

from django.utils.log import configure_logging


def _logged(settings) -> str:
    """설정의 LOGGING을 적용한 채 요청 오류 하나와 404 경고 하나를 낸 뒤 stderr에 나온 글을 돌려준다."""
    stream = io.StringIO()
    try:
        with redirect_stderr(stream):
            configure_logging(settings.LOGGING_CONFIG, settings.LOGGING)
            logger = logging.getLogger("django.request")
            try:
                raise RuntimeError("boom-trace")
            except RuntimeError as exc:
                logger.error("Internal Server Error: /api/x", exc_info=exc)
            logger.warning("Not Found: /api/y")
    finally:
        configure_logging(settings.LOGGING_CONFIG, settings.LOGGING)  # 핸들러를 원래 stderr로 되돌린다
    return stream.getvalue()


def test_server_error_traceback_reaches_console_when_debug_is_off(settings):
    settings.DEBUG = False
    out = _logged(settings)
    assert out.count("RuntimeError: boom-trace") == 1 and "Internal Server Error: /api/x" in out
    assert "Not Found" not in out  # 404 같은 경고는 운영 로그를 채우지 않는다


def test_server_error_is_logged_once_when_debug_is_on(settings):
    settings.DEBUG = True
    out = _logged(settings)
    assert out.count("RuntimeError: boom-trace") == 1  # Django 기본 콘솔 핸들러와 겹쳐 두 번 나오지 않는다
