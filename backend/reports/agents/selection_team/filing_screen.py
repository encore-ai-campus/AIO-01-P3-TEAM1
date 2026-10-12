"""후보 공시 점검 Worker `filing_screen_agent` → FilingCheckResult (docs/design/AI_AGENT_WORKFLOW.md 2·4장).

후보마다 최근 FILING_DAYS일 DART 공시 제목(longterm.sources.dart_client)을 모아 LLM 한 번에 준다 (후보마다 최신 PROMPT_FILINGS개).
제목은 guards.clean_text를 거친다. DART 키가 없거나 조회가 실패한 후보는 "자료 없음"으로 넘긴다.
우선주처럼 DART 고유번호가 없는 종목은 보통주 코드(끝자리 0)의 공시를 본다.
코드 바닥(floor): FILING_DAYS일 공시 전부(최대 FLOOR_FILINGS개) 중 제목에 HIGH_RISK_KEYWORDS가 든 공시가 있는 후보는 LLM이 뭐라 하든
severity "high"이고 그 공시가 근거다 (선정 Guard가 high를 뺀다). 다만 지정 해제·취소·해소처럼 위험이 풀렸다는 공시(RESOLVED_WORDS)는 바닥에서 뺀다.
후보 표 밖 종목은 버린다. LLM이 빠뜨린 후보는 바닥에 걸리면 high로 넣고, 아니면 빠진 채로 둔다.
"""
from datetime import date, datetime
from zoneinfo import ZoneInfo

from longterm import sources

from ...guardrails import guards
from ..base import WorkerContext
from ..prompts import NO_DATA, system_prompt, user_prompt
from .team import candidates_of, gather

KST = ZoneInfo("Asia/Seoul")
FILING_DAYS = 30
TITLE_MAX = 200
PROMPT_FILINGS = 10   # 후보마다 LLM에 넣는 최신 공시 수
FLOOR_FILINGS = 100   # 코드 바닥이 보는 공시 수 (30일 전부 — DART 한 쪽)
NO_FILINGS = f"최근 {FILING_DAYS}일 공시 없음"
# 제목에 이 말이 있으면 위험 high (공백을 지우고 비교한다)
HIGH_RISK_KEYWORDS = ("관리종목", "상장폐지", "상장적격성", "횡령", "배임", "감사의견", "의견거절", "불성실공시",
                      "회생", "파산", "부도", "거래정지", "자본잠식")
# 위험이 풀렸거나 해당하지 않는다는 공시 (예: 관리종목지정해제, 매매거래정지해제, 상장적격성실질심사대상아님) — 바닥에서 뺀다
RESOLVED_WORDS = ("해제", "아님", "종결", "취소", "해소", "철회", "미해당", "비해당")

ROLE = """너는 매매 후보 종목의 최근 공시에서 위험 신호를 찾는 점검 담당이다.
후보마다 공시 제목을 보고 위험 정도(severity)를 매긴다."""

RULES = f"""- severity high: 관리종목 지정, 상장폐지·상장적격성 심사, 횡령·배임, 감사의견 거절, 불성실공시, 회생·파산·부도,
  매매거래정지, 자본잠식처럼 거래 자체가 위험한 신호.
  low: 유상증자, 전환사채·신주인수권부사채 발행, 최대주주 지분 매도, 소송처럼 주가에 부담이 될 수 있는 신호.
  none: 위험 신호 없음 (정기보고서, 자기주식 취득, 기업설명회 등).
- signals에는 위험 신호를 짧게, evidence에는 근거 공시를 "날짜 제목" 꼴로 쓴다. 공시 제목에 없는 내용은 쓰지 않는다.
- 공시가 "{NO_FILINGS}"인 후보는 severity none, signals·evidence는 빈 목록.
- 공시가 "{NO_DATA}"인 후보는 items에 넣지 않는다.
- 후보 목록에 있는 종목만 쓴다. symbol은 후보 목록의 코드를 그대로 쓴다.
- summary는 후보 전체의 공시 위험을 2~3문장으로 쓴다."""


class FilingScreenAgent:
    id = "filing_screen_agent"
    output_contract = "FilingCheckResult"

    def run(self, ctx: WorkerContext) -> dict:
        rows = candidates_of(ctx)
        dart = sources.dart_client()
        today = _day(ctx)
        guarded: list[list[str]] = []
        flagged: dict[str, dict] = {}  # symbol → 고위험 단어가 든 첫 공시 {keyword, evidence}

        def fetch(row: dict) -> list[dict] | str:
            found = None
            for code in _dart_codes(row["symbol"]):
                found = dart.disclosures(code, today, days=FILING_DAYS, limit=FLOOR_FILINGS)
                if found is not None:
                    break
            if found is None:  # DART 고유번호가 없는 종목
                return NO_DATA
            filings = []
            for item in found.get("items") or []:
                title, why = guards.clean_text(item.get("title"), TITLE_MAX)
                if not title.strip():
                    continue
                keyword = risk_keyword(item.get("title") or "")
                if keyword and row["symbol"] not in flagged:
                    flagged[row["symbol"]] = {"keyword": keyword, "evidence": f"{item.get('date') or ''} {title}".strip()}
                if len(filings) < PROMPT_FILINGS:
                    guarded.append(why)
                    filings.append({"date": item.get("date"), "title": title})
            return filings

        filings = gather(ctx, rows, fetch) if dart is not None else {row["symbol"]: NO_DATA for row in rows}
        listing = [{"symbol": row["symbol"], "name": row.get("name"), "filings": filings[row["symbol"]] or NO_FILINGS}
                   for row in rows]
        user = user_prompt({f"후보별 공시 제목 (최근 {FILING_DAYS}일, DART)": listing})
        reply = ctx.llm(system_prompt(ROLE, self.output_contract, RULES), user, contract=self.output_contract)
        result = settle(reply.data, rows, flagged)
        reasons = guards.merge_reasons(*guarded)
        return (result | {"_guarded": reasons}) if reasons else result


def risk_keyword(title: str) -> str | None:
    """공시 제목에 든 첫 고위험 단어 (공백을 지우고 비교). 없거나 위험이 풀렸다는 공시(RESOLVED_WORDS)면 None."""
    squashed = "".join(title.split())
    if any(word in squashed for word in RESOLVED_WORDS):
        return None
    return next((keyword for keyword in HIGH_RISK_KEYWORDS if keyword in squashed), None)


def _dart_codes(symbol: str) -> list[str]:
    """DART에서 찾아볼 종목 코드: 그 종목, 우선주(끝자리가 0이 아님)면 이어서 보통주 코드 (DART 고유번호는 보통주에만 있다)."""
    return [symbol] if symbol.endswith("0") or len(symbol) != 6 else [symbol, f"{symbol[:-1]}0"]


def settle(data: dict, rows: list[dict], flagged: dict[str, dict]) -> dict:
    """계약을 통과한 LLM 결과에 코드 바닥을 씌운다: 후보 밖 종목은 버리고, 고위험 단어가 든 후보는 high + 그 공시를 근거 맨 앞에."""
    order = [row["symbol"] for row in rows]
    by_symbol = {item["symbol"]: item for item in data["items"] if item["symbol"] in set(order)}
    raised = 0
    for symbol, hit in flagged.items():
        item = by_symbol.get(symbol) or {"symbol": symbol, "severity": "none", "signals": [], "evidence": []}
        raised += item["severity"] != "high"
        by_symbol[symbol] = item | {"severity": "high",
                                    "signals": _first(f"고위험 공시: {hit['keyword']}", item["signals"]),
                                    "evidence": _first(hit["evidence"], item["evidence"])}
    summary = data["summary"]
    if raised:
        summary = f"{summary} (코드 확인: 고위험 공시 제목이 있는 {raised}개 종목은 위험 high로 정했습니다.)"
    return {"summary": summary, "items": [by_symbol[symbol] for symbol in order if symbol in by_symbol]}


def _first(value: str, items: list[str]) -> list[str]:
    return [value, *(item for item in items if item != value)]


def _day(ctx: WorkerContext) -> date:
    """공시를 볼 기준일: 후보 표의 날짜(team_inputs.day). 없거나 틀리면 오늘(KST)."""
    try:
        return date.fromisoformat(str((ctx.team_inputs or {}).get("day")))
    except ValueError:
        return datetime.now(KST).date()
