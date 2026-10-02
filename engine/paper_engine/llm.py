"""LLM 게이트웨이(DevPass, OpenAI 호환) 클라이언트."""
import json
import threading
import time
import urllib.error
import urllib.request

BASE_URL = "https://api.llmgateway.io/v1"
MAX_ATTEMPTS = 2  # 응답 형식 오류나 서버 오류일 때만 다시 시도한다
TIMEOUT_SEC = 90
WEB_SEARCH_MAX_USES = 5


class LlmError(Exception):
    pass


class LlmTimeout(LlmError):
    """제한 시간 안에 응답이 없음. 느린 모델을 기다리지 않기 위해 다시 시도하지 않는다."""


def extract_json(text: str) -> dict:
    """응답에서 JSON 객체를 꺼낸다. 코드 펜스나 앞뒤 설명이 붙어 있어도 처리한다."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise LlmError(f"JSON 객체가 없는 응답: {text[:200]!r}")
    try:
        data = json.loads(text[start:end + 1])
    except ValueError as e:
        raise LlmError(f"JSON 파싱 실패 ({e}): {text[:200]!r}") from None
    if not isinstance(data, dict):
        raise LlmError("JSON 최상위가 객체가 아님")
    return data


class LlmClient:
    def __init__(self, api_key: str, base_url: str = BASE_URL):
        self._api_key = api_key
        self._base_url = base_url
        self._lock = threading.Lock()
        self.cost = 0.0  # 누적 비용 (USD, 게이트웨이 보고 기준)

    def complete_json(self, model: str, system: str, user: str,
                      timeout: int = TIMEOUT_SEC) -> dict:
        return self._request_json(model, system, user, timeout=timeout)[0]

    def research_json(self, model: str, system: str, user: str,
                      timeout: int = TIMEOUT_SEC) -> tuple[dict, list[dict]]:
        """웹 검색을 켜고 호출한다. (응답 JSON, 검색 인용 목록)을 반환한다.

        인용 목록은 모델에 따라 비어 있을 수 있다.
        """
        return self._request_json(model, system, user, timeout=timeout,
                                  tools=[{"type": "web_search", "max_uses": WEB_SEARCH_MAX_USES}])

    def _request_json(self, model: str, system: str, user: str, tools: list | None = None,
                      timeout: int = TIMEOUT_SEC) -> tuple[dict, list[dict]]:
        # JSON 모드(response_format)는 모델마다 지원 여부가 달라 쓰지 않는다.
        body = {"model": model, "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]}
        if tools:
            body["tools"] = tools
        payload = json.dumps(body).encode()
        last_error = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                message = self._post(payload, timeout)
                return extract_json(message["content"]), message.get("annotations") or []
            except LlmTimeout as e:
                raise LlmTimeout(f"{model}: {e}") from None
            except LlmError as e:
                last_error = e
                time.sleep(2 * attempt)
        raise LlmError(f"{model}: {last_error}")

    def _post(self, payload: bytes, timeout: int) -> dict:
        req = urllib.request.Request(
            self._base_url + "/chat/completions", data=payload, method="POST",
            headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                body = json.loads(res.read())
        except urllib.error.HTTPError as e:
            raise LlmError(f"HTTP {e.code}: {e.read()[:300].decode(errors='replace')}") from None
        except TimeoutError:
            raise LlmTimeout(f"{timeout}초 안에 응답 없음") from None
        except urllib.error.URLError as e:
            if isinstance(e.reason, TimeoutError):
                raise LlmTimeout(f"{timeout}초 안에 응답 없음") from None
            raise LlmError(f"요청 실패: {e}") from None
        except ValueError as e:
            raise LlmError(f"요청 실패: {e}") from None
        with self._lock:
            self.cost += (body.get("usage") or {}).get("cost") or 0.0
        message = body["choices"][0]["message"]
        if not message.get("content"):
            raise LlmError("빈 응답")
        return message
