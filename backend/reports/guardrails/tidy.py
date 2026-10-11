"""리포트 결과의 결정론적 후처리와 쉬운 글 전문 용어 표 (docs/records/운영E2E점검_UX리뷰_2026-10-08.md UX-4·UX-5). Claude 파일.

Orchestrator가 Worker 결과를 출력 계약으로 검증한 뒤 State에 저장하기 전(state.add_result)에 `tidy_result`를 한 번 부른다.
- 쉼표 없는 원 금액: "201000원" → "201,000원" (4자리 이상 정수 + "원").
- 한국어 문장 속 의견 영어: "AI 의견은 hold예요" → "AI 의견은 지켜보기예요" (뒤 조사도 받침에 맞춘다).
  verdict 같은 값 필드는 그대로 두고 사람이 읽는 글만 바꾼다. 영어 문구 속 낱말("Strong Buy")은 그대로다.
- 종목 리포트 초안(ReportDraft)의 쉬운 글(EASY_FIELDS)에 남은 전문 용어에는 처음 한 번 괄호 풀이를 붙인다:
  "이동평균선" → "이동평균선(최근 며칠 동안의 평균 가격)". 검토가 고쳐 쓰게 할 수 있는 동안은 Guard(guards.easy_jargon)가
  RETRY로 고쳐 쓰게 하고, 한도를 넘으면 리포트를 실패시키지 않고 이 풀이를 붙인 채로 통과한다.
- 출력 계약의 길이 상한을 넘게 되는 글은 바꾸지 않는다 (계약 검증이 뒤를 자르지 않게).
추천(autotrade.recommend.sources.from_report)은 리포트의 oneLiner·reasons·risks를 그대로 옮기므로 추천 문장도 이 후처리를 거친 값이다.
"""
import re

from .contracts import LIST_ITEM_MAX, ONE_LINER_MAX, PLAIN_ITEM_MAX, SUMMARY_MAX

# 쉬운 보기·쉬운 판 PDF가 읽는 ReportDraft 필드 (easy_text.draft_of) — 전문 용어를 쓰지 않는다
EASY_FIELDS = ("oneLiner", "plainSummary", "reasons", "risks")

# 쉬운 글에 쓰지 않는 전문 용어: (이름, 찾는 정규식, 괄호 풀이). 이름은 작성 프롬프트와 Guard 사유에 그대로 나온다.
# 풀이에는 숫자·이 표의 용어·권유 표현을 넣지 않는다 (plainSummary는 숫자 금지 — 테스트가 확인한다).
JARGON = (
    ("이동평균선", r"이동\s*평균\s*선?|이평선|[0-9]+일선(?![물택거박])", "최근 며칠 동안의 평균 가격"),
    ("지지선", r"지지\s*선", "그동안 더 내려가지 않고 버텨 온 가격대"),
    ("저항선", r"저항\s*선", "그동안 더 오르지 못하고 막혀 온 가격대"),
    # 이탈·돌파는 가격 문맥일 때만 ("고객 이탈", "매출 1조 원 돌파"는 일반 낱말)
    ("이탈", r"(?:선|가격대?|지지|저항|고점|저점|박스권|구간|아래로|밑으로)\s*(?:을|를|에서)?\s*이탈(?!리아)", "정해 둔 가격대를 벗어남"),
    ("돌파", r"(?:선|가격대?|저항|고점|박스권|구간|위로)\s*(?:을|를)?\s*돌파(?!구)", "막혀 온 가격대를 뚫고 넘어섬"),
    ("등락률", r"등락\s*률", "가격이 오르내린 비율"),
    ("RSI", r"(?<![A-Za-z])RSI(?![A-Za-z])", "최근 오른 폭과 내린 폭을 비교한 점수"),
    ("MACD", r"(?<![A-Za-z])MACD(?![A-Za-z])", "짧은 기간과 긴 기간 평균 가격의 차이로 본 흐름"),
    ("PER", r"(?<![A-Za-z])PER(?![A-Za-z])", "회사가 버는 돈에 비해 주가가 몇 배인지"),
    ("PBR", r"(?<![A-Za-z])PBR(?![A-Za-z])", "회사가 가진 재산에 비해 주가가 몇 배인지"),
    ("ROE", r"(?<![A-Za-z])ROE(?![A-Za-z])", "회사가 자기 돈으로 낸 이익의 비율"),
    ("EPS", r"(?<![A-Za-z])EPS(?![A-Za-z])", "주식 한 주가 번 이익"),
    ("밸류에이션", r"밸류\s*에이션", "회사 가치에 비해 주가가 비싼지 싼지"),
    ("모멘텀", r"모멘텀", "가격이 움직이는 기세"),
    ("변동성", r"변동성", "가격이 오르내리는 폭"),
    ("손익비", r"손익비", "예상 손해에 비해 기대하는 이익의 크기"),
    ("컨센서스", r"컨센서스", "증권사 전문가들의 예상 평균"),
    ("턴어라운드", r"턴\s*어라운드", "나빠지던 실적이 좋아지는 쪽으로 돌아섬"),
    ("골든크로스", r"골든\s*크로스", "짧은 기간 평균 가격이 긴 기간 평균 가격 위로 올라섬"),
    ("데드크로스", r"데드\s*크로스", "짧은 기간 평균 가격이 긴 기간 평균 가격 아래로 내려감"),
    ("과매수", r"과매수", "짧은 기간에 많이 오른 상태"),
    ("과매도", r"과매도", "짧은 기간에 많이 내린 상태"),
    ("박스권", r"박스권", "일정한 가격 범위 안에서 오르내리는 상태"),
)
_JARGON = [(name, re.compile(pattern), plain) for name, pattern, plain in JARGON]
PLAIN = {name: plain for name, _, plain in JARGON}

# 사람이 읽는 글의 의견 영어 → 한국어 (화면 배지·OPINION_TEXT와 같은 말)
OPINION_KO = {"buy": "매수", "hold": "지켜보기", "watch": "지켜보기", "sell": "매도", "avoid": "부정적"}
_OPINION = re.compile(r"(?<![A-Za-z0-9_\-/&'.=?#:%])(buy|hold|watch|sell|avoid)(?![A-Za-z0-9_\-/&'=])", re.IGNORECASE)  # 링크 주소 안 제외
_HANGUL = re.compile(r"[가-힣]")
_MARKUP = set(" \t*_\"'`“”‘’")   # 낱말 옆에서 건너뛰는 공백·강조·따옴표
# 바뀐 낱말 바로 뒤의 조사: (받침 있을 때, 없을 때). 긴 것부터 맞춘다. 격조사(_CASE)는 뒤가 한글이 아닐 때만 ("이고"의 "이"는 조사가 아니다)
_PARTICLES = (("이에요", "예요"), ("이었", "였"), ("이라고", "라고"), ("이라는", "라는"), ("이라서", "라서"),
              ("이라면", "라면"), ("으로", "로"), ("이", "가"), ("은", "는"), ("을", "를"), ("과", "와"))
_PARTICLE_FORMS = sorted(((form, pair) for pair in _PARTICLES for form in pair), key=lambda item: -len(item[0]))
_CASE = {"이", "가", "은", "는", "을", "를", "과", "와"}

_WON = re.compile(r"(?<![0-9,.])([1-9][0-9]{3,})(?=\s?원(?![/화]))")  # "2026 원/달러"·"원화"는 금액이 아니다

# 계약마다 후처리할 글 필드와 그 길이 상한 (contracts.py와 같은 값. None이면 상한 없음)
FIELDS = {
    "ReportDraft": {"title": LIST_ITEM_MAX, "oneLiner": ONE_LINER_MAX, "plainSummary": PLAIN_ITEM_MAX,
                    "reasons": LIST_ITEM_MAX, "risks": LIST_ITEM_MAX, "markdown": None},
    "MarketResult": {"summary": SUMMARY_MAX},
    "FundamentalResult": {"summary": SUMMARY_MAX},
    "NewsResult": {"summary": SUMMARY_MAX},
    "RiskResult": {"summary": SUMMARY_MAX, "warnings": LIST_ITEM_MAX},
}


def tidy_result(contract: str, result: dict) -> dict:
    """계약을 통과한 Worker 결과의 사람이 읽는 글을 후처리한 새 dict (FIELDS에 없는 계약은 그대로)."""
    fields = FIELDS.get(contract)
    if not fields or not isinstance(result, dict):
        return result
    out = dict(result)
    for field, limit in fields.items():
        easy = contract == "ReportDraft" and field in EASY_FIELDS
        value = out.get(field)
        if isinstance(value, list):
            out[field] = [_tidy(item, limit, easy) for item in value]
        elif isinstance(value, str):
            out[field] = _tidy(value, limit, easy)
    return out


def jargon_terms(text) -> list[str]:
    """글에 있는 전문 용어 이름 (JARGON 순서, 중복 없이). 문자열이 아니면 빈 목록."""
    if not isinstance(text, str):
        return []
    return [name for name, pattern, _ in _JARGON if pattern.search(text)]


_SOURCE_TAIL = re.compile(r"\s*[(\[（]\s*(?:출처|근거)\s*[:：]\s*[^)\]）]+?\s*[)\]）]\s*\Z")  # easy_text.SOURCE_TAIL과 같은 꼴


def explain_jargon(text: str, limit: int | None = None) -> str:
    """용어마다 처음 나온 곳 바로 뒤에 괄호 풀이를 붙인다. 이미 괄호가 이어지면 그대로, limit을 넘게 되는 풀이는 붙이지 않는다.

    끝의 출처 괄호("(근거: 일봉 RSI)")는 화면·쉬운 PDF가 떼어 따로 보이므로 건드리지 않는다.
    """
    tail = _SOURCE_TAIL.search(text)
    if tail:
        head = explain_jargon(text[:tail.start()], None if limit is None else limit - (len(text) - tail.start()))
        return head + text[tail.start():]
    for _, pattern, plain in _JARGON:
        match = pattern.search(text)
        if match is None or text[match.end():match.end() + 1] in ("(", "（"):
            continue
        explained = f"{text[:match.end()]}({plain}){text[match.end():]}"
        if limit is None or len(explained) <= limit:
            text = explained
    return text


def won_commas(text: str) -> str:
    """쉼표 없는 원 금액(4자리 이상 정수 + "원")에 천 단위 쉼표를 넣는다. 소수·이미 쉼표가 있는 수는 그대로."""
    return _WON.sub(lambda match: f"{int(match.group(1)):,}", text)


def korean_opinions(text: str) -> str:
    """한글이 있는 줄의 의견 영어(buy·hold·watch·sell·avoid, 대소문자 무관)를 한국어로. 영어 문구 속 낱말은 그대로."""
    return "\n".join(_opinion_line(line) if _HANGUL.search(line) else line for line in text.split("\n"))


def _tidy(text, limit: int | None, easy: bool):
    if not isinstance(text, str):
        return text
    fixed = korean_opinions(won_commas(text))
    if limit is not None and len(fixed) > limit:
        fixed = text
    return explain_jargon(fixed, limit) if easy else fixed


def _opinion_line(line: str) -> str:
    out, last = [], 0
    for match in _OPINION.finditer(line):
        if _english_neighbor(line, match.start(), match.end()) or line[match.start() - 1:match.end() + 1] == f"({match.group(1)})":
            continue  # 영어 문구 속 낱말, 또는 "매수(buy)" 같은 괄호 풀이
        word = OPINION_KO[match.group(1).lower()]
        tail = match.end()
        while tail < len(line) and line[tail] in _MARKUP and line[tail] not in " \t":  # "**hold**예요"의 닫는 강조
            tail += 1
        out += [line[last:match.start()], word, line[match.end():tail]]
        found = _particle(line, tail)
        if found:
            form, pair = found
            out.append(pair[0] if _needs_consonant_form(word, pair) else pair[1])
            tail += len(form)
        last = tail
    out.append(line[last:])
    return "".join(out)


def _particle(line: str, at: int) -> tuple[str, tuple[str, str]] | None:
    """at에서 시작하는 조사 (맞은 글자, (받침 있을 때, 없을 때)). 격조사 한 글자는 뒤가 한글이 아닐 때만."""
    rest = line[at:]
    for form, pair in _PARTICLE_FORMS:
        if rest.startswith(form) and (form not in _CASE or not _HANGUL.match(rest[len(form):len(form) + 1])):
            return form, pair
    return None


def _needs_consonant_form(word: str, pair: tuple[str, str]) -> bool:
    code = ord(word[-1]) - 0xAC00
    if not 0 <= code < 11172 or code % 28 == 0:
        return False
    return not (pair == ("으로", "로") and code % 28 == 8)  # ㄹ 받침 뒤는 "로"


def _english_neighbor(line: str, start: int, end: int) -> bool:
    """공백·강조·따옴표를 건너뛴 바로 옆 글자가 영문자면 영어 문구 속 낱말이다."""
    left = start - 1
    while left >= 0 and line[left] in _MARKUP:
        left -= 1
    right = end
    while right < len(line) and line[right] in _MARKUP:
        right += 1
    return any(0 <= i < len(line) and line[i].isascii() and line[i].isalpha() for i in (left, right))
