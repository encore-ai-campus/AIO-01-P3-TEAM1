"""펀더멘털 점검 — 순수 함수 (docs/API.md "장기투자"의 "지표와 판정" 표, docs/DECISIONS.md 14-3. 제안값 E-5).

DART `fundamentals`(data/dart.py) 하나를 9개 지표 행(FundamentalsRow)과 종합 판정으로 바꾼다. 판정은 결정론이다 (LLM 없음).

  evaluate(fundamentals, baseline=None, previous=None) → {"rows", "overall", "facts", "period", "receivedAt"}
    baseline   산 이유의 기준선 {지표: 값} (없으면 None — 기준선이 필요한 판정은 절대 기준 부분만)
    previous   직전 점검(다른 보고서 기간)의 facts — "2개 보고서 연속" 조건에만 쓴다 (없으면 None)
  overall_of(rows) · worse(new, old) · baseline_from(rows) · applicability(...) · OVERALL_LABELS · CAPTION

판정 우선순위는 bad > warn > ok (한 행에서 여러 칸이 맞으면 나쁜 쪽). 판정에 쓰는 값이 없으면 na.
종합: bad 하나라도 → review, warn 둘 이상 → caution, 나머지 solid. na 행은 세지 않고, 판정한 행이 없으면 na.
표기는 중립 문구다 (OVERALL_LABELS — "견조"·"점검 필요"처럼 좋다·나쁘다로 읽히는 말을 쓰지 않는다).
"""

KEYS = ("revenueGrowth", "operatingIncomeGrowth", "operatingMargin", "roe", "debtRatio", "currentRatio",
        "interestCoverage", "operatingCashFlow", "earningsQuality")
LABELS = {
    "revenueGrowth": "매출 성장", "operatingIncomeGrowth": "영업이익 성장", "operatingMargin": "영업이익률(TTM)",
    "roe": "ROE(TTM)", "debtRatio": "부채비율", "currentRatio": "유동비율", "interestCoverage": "이자보상배율(근사)",
    "operatingCashFlow": "영업현금흐름", "earningsQuality": "이익의 질",
}
AXES = {
    "revenueGrowth": "growth", "operatingIncomeGrowth": "growth", "operatingMargin": "profitability",
    "roe": "profitability", "debtRatio": "balance_sheet", "currentRatio": "balance_sheet",
    "interestCoverage": "balance_sheet", "operatingCashFlow": "profitability", "earningsQuality": "profitability",
}
UNITS = {
    "revenueGrowth": "ratio", "operatingIncomeGrowth": "ratio", "operatingMargin": "ratio", "roe": "ratio",
    "debtRatio": "ratio", "currentRatio": "ratio", "interestCoverage": "times", "operatingCashFlow": "krw",
    "earningsQuality": "times",
}
THESIS_AXES = ("growth", "profitability", "balance_sheet")
BASELINE_KEYS = ("operatingMargin", "roe", "debtRatio")  # 기준선과 비교하는 지표 (기간이 바뀌지 않는 값: TTM·기말 잔액)
OK, WARN, BAD, NA = "ok", "warn", "bad", "na"
SOLID, CAUTION, REVIEW = "solid", "caution", "review"
OVERALL_LABELS = {SOLID: "기준 충족", CAUTION: "주의", REVIEW: "확인 필요", NA: "적용하지 않음"}
_RANK = {SOLID: 0, CAUTION: 1, REVIEW: 2}  # 나쁜 순서 solid < caution < review (na는 순서 밖)
CAPTION = "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다"
SOURCE = "금융감독원 OpenDART"

# 적용하지 않는 종목. 금융업은 한국표준산업분류 대분류 K(64 금융업 · 65 보험 및 연금업 · 66 금융 및 보험 관련 서비스업)
FINANCIAL_INDUSTRY_PREFIXES = ("64", "65", "66")
APPLICABLE_TYPES = ("STOCK", "UNKNOWN")  # 증권사 종목 정보의 securityType. 모르면(UNKNOWN·없음) 적용해 본다
NOT_APPLICABLE = {
    "us": "미국 종목은 국내 일반 기업용 점검을 적용하지 않아요",
    "etf": "ETF·ETN은 일반 기업용 점검을 적용하지 않아요",
    "reit": "리츠는 일반 기업용 점검을 적용하지 않아요",
    "type": "일반 기업 주식이 아니라 일반 기업용 점검을 적용하지 않아요",
    "financial": "금융업은 일반 기업용 점검을 적용하지 않아요",
}
NO_DATA = "자료 없음"
NEED_BASELINE = "기준선이 있어야 판정해요"
ROE_APPROX = "근사: 순이익(TTM) ÷ 기말 자본총계"
COVERAGE_APPROX = "근사: 영업이익 ÷ 금융비용 (같은 누적 기간)"


def applicability(market: str, security_type: str | None = None, name: str = "",
                  industry_code: str | None = None) -> tuple[bool, str | None]:
    """(일반 기업용 점검을 적용하는지, 적용하지 않으면 이유 한 줄). 금융업·ETF·ETN·리츠·미국 종목은 적용하지 않는다.

    industry_code는 DART 회사 개황의 업종 코드 (없으면 금융업인지 모른다 — 적용한다).
    """
    if market != "KR":
        return False, NOT_APPLICABLE["us"]
    kind = (security_type or "UNKNOWN").upper()
    if kind in ("ETF", "ETN"):
        return False, NOT_APPLICABLE["etf"]
    if kind == "REIT" or "리츠" in (name or ""):
        return False, NOT_APPLICABLE["reit"]
    if kind not in APPLICABLE_TYPES:
        return False, NOT_APPLICABLE["type"]
    if industry_code and str(industry_code).strip()[:2] in FINANCIAL_INDUSTRY_PREFIXES:
        return False, NOT_APPLICABLE["financial"]
    return True, None


def _num(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _growth(current: float | None, previous: float | None) -> float | None:
    if current is None or previous is None or previous <= 0:
        return None
    return round(current / previous - 1, 4)


def _round(value: float | None, digits: int) -> float | None:
    return None if value is None else round(value, digits)


def report_label(fundamentals: dict | None) -> str | None:
    """보고서 표시 이름 ("2026 반기보고서"). dart.fundamentals의 report가 없으면 기간 문자열."""
    if not fundamentals:
        return None
    report = fundamentals.get("report") or {}
    if report.get("label"):
        return report["label"]
    latest = fundamentals.get("interim") or fundamentals.get("annual") or {}
    return latest.get("period")


def metrics(fundamentals: dict | None) -> dict:
    """DART fundamentals → 지표 값(values, FundamentalsRow.value와 같은 unit)과 판정에만 쓰는 값.

    성장률은 최신 보고서 기준이다: 분기·반기 보고서가 있으면 그 누적의 전년 같은 기간 대비, 없으면 연간.
    ROE는 공시 지표(reported.roe — 분기 보고서면 누적·연환산 아님)를 쓰지 않고 순이익(TTM) ÷ 기말 자본총계로 계산한다.
    이자보상배율은 최신 보고서의 같은 누적 기간의 영업이익 ÷ 금융비용이다 (기간을 섞지 않는다).
    """
    f = fundamentals or {}
    ratios = f.get("ratios") or {}
    interim, annual = f.get("interim"), f.get("annual") or {}
    reported = f.get("reported") or {}
    if interim:
        revenue = (_num(interim.get("revenue")), _num((interim.get("samePeriodLastYear") or {}).get("revenue")))
        operating = (_num(interim.get("operatingIncome")),
                     _num((interim.get("samePeriodLastYear") or {}).get("operatingIncome")))
    else:
        previous_year = annual.get("previousYear") or {}
        revenue = (_num(annual.get("revenue")), _num(previous_year.get("revenue")))
        operating = (_num(annual.get("operatingIncome")), _num(previous_year.get("operatingIncome")))
    turned_loss = operating[0] is not None and operating[1] is not None and operating[1] > 0 and operating[0] < 0
    ttm, balance = f.get("ttm") or {}, f.get("balance") or {}
    net_ttm, equity = _num(ttm.get("netIncome")), _num(balance.get("totalEquity"))
    roe = round(net_ttm / equity, 4) if net_ttm is not None and equity is not None and equity > 0 else None
    non_operating = f.get("nonOperating") or {}
    finance_costs = _num(non_operating.get("financeCosts"))
    coverage_income = _num((interim or annual).get("operatingIncome")) if non_operating else None
    coverage = (round(coverage_income / finance_costs, 2)
                if coverage_income is not None and finance_costs is not None and finance_costs > 0 else None)
    cash = f.get("cashFlow") or {}
    values = {
        "revenueGrowth": _growth(*revenue),
        "operatingIncomeGrowth": None if turned_loss else _growth(*operating),
        "operatingMargin": _round(_num(ratios.get("operatingMargin")), 4),
        "roe": roe,
        "debtRatio": _round(_num(reported.get("debtRatio")), 4),
        "currentRatio": _round(_num(reported.get("currentRatio")), 4),
        "interestCoverage": coverage,
        "operatingCashFlow": _num(cash.get("operatingCashFlow")),
        "earningsQuality": _round(_num(ratios.get("netIncomeToOperatingIncome")), 2),
    }
    report = f.get("report") or {}
    return {
        "values": values,
        "operatingIncomeTurnedLoss": turned_loss,
        "operatingIncomeBaseNonPositive": operating[1] is not None and operating[1] <= 0,
        "netIncomeSamePeriod": _num(cash.get("netIncome")),
        "nonOperatingShare": _round(_num(ratios.get("nonOperatingShareOfPretaxIncome")), 4),
        "period": report_label(fundamentals),
        "receivedAt": report.get("receivedAt"),
    }


def _pct(value: float, digits: int = 1) -> str:
    return f"{value * 100:.{digits}f}%"


def _pp(change: float) -> str:
    return f"{'+' if change >= 0 else '−'}{abs(change) * 100:.1f}%p"


def _profit_cash_short(net_income: float | None, cash: float | None) -> bool:
    """순이익 흑자인데 영업현금흐름이 0 이하 (2개 보고서 연속이면 bad)."""
    return net_income is not None and cash is not None and net_income > 0 and cash <= 0


def _judge(key: str, m: dict, base: float | None, previous: dict | None) -> tuple[str, str | None]:
    """한 행의 (status, note). base는 이 지표의 기준선 값 (기준선을 쓰지 않는 지표면 None)."""
    v = m["values"][key]
    # 경계(+0.20 등)가 부동소수점 오차로 넘어가지 않게 소수 여섯째 자리로 맞춘 뒤 비교한다
    change = None if v is None or base is None else round(v - base, 6)
    if key == "revenueGrowth":
        if v is None:
            return NA, NO_DATA
        before = _num((previous or {}).get("revenueGrowth"))
        if v < 0 and before is not None and before < 0:
            return BAD, "2개 보고서 연속 감소"
        return (BAD if v < -0.10 else WARN if v < 0 else OK), None
    if key == "operatingIncomeGrowth":
        if m["operatingIncomeTurnedLoss"]:
            return BAD, "적자 전환"
        if v is None:
            return NA, "비교 기간 영업이익이 0 이하라 계산하지 않아요" if m["operatingIncomeBaseNonPositive"] else NO_DATA
        return (BAD if v < -0.20 else WARN if v < 0 else OK), None
    if key == "operatingMargin":
        if v is None:
            return NA, NO_DATA
        if v < 0:
            return BAD, "영업이익률이 음수"
        if change is None:
            return NA, NEED_BASELINE
        return (BAD if change < -0.03 else WARN if change < -0.01 else OK), f"기준선 대비 {_pp(change)}"
    if key == "roe":
        if v is None:
            return NA, NO_DATA
        if v <= 0:
            return BAD, f"ROE가 0 이하 ({ROE_APPROX})"
        if change is None:
            return NA, f"{NEED_BASELINE} ({ROE_APPROX})"
        return (WARN if change < -0.02 else OK), f"기준선 대비 {_pp(change)} ({ROE_APPROX})"
    if key == "debtRatio":
        if v is None:
            return NA, NO_DATA
        if change is None:
            return NA, NEED_BASELINE
        return (BAD if change > 0.50 else WARN if change > 0.20 else OK), f"기준선 대비 {_pp(change)}"
    if key == "currentRatio":
        if v is None:
            return NA, NO_DATA
        return (BAD if v < 0.8 else WARN if v < 1.0 else OK), None
    if key == "interestCoverage":
        if v is None:
            return NA, "금융비용이 없어 계산하지 않아요"
        return (BAD if v < 1 else WARN if v < 3 else OK), COVERAGE_APPROX
    if key == "operatingCashFlow":
        net = m["netIncomeSamePeriod"]
        if v is None or net is None:
            return NA, NO_DATA
        if net > 0 and v > 0:
            return OK, None
        if net <= 0 and v <= 0:
            return BAD, "순이익 적자이고 영업현금흐름도 0 이하"
        if net > 0:  # 흑자인데 영업현금흐름 ≤ 0
            before = previous or {}
            if _profit_cash_short(_num(before.get("netIncomeSamePeriod")), _num(before.get("operatingCashFlow"))):
                return BAD, "순이익 흑자인데 영업현금흐름이 0 이하 — 2개 보고서 연속"
            return WARN, "순이익은 흑자인데 영업현금흐름이 0 이하"
        return WARN, "순이익은 적자인데 영업현금흐름은 플러스"
    if key == "earningsQuality":
        share = m["nonOperatingShare"]
        if share is None:
            return NA, NO_DATA
        note = f"판정: 영업외 손익이 세전이익의 {share * 100:.0f}%"
        return (WARN if abs(share) >= 0.5 else OK), note
    raise ValueError(f"모르는 지표: {key}")


def overall_of(rows: list[dict]) -> str:
    """종합: bad 하나라도 → review, warn 둘 이상 → caution, 나머지 solid. 판정한 행(na 아님)이 없으면 na."""
    judged = [r["status"] for r in rows if r["status"] != NA]
    if not judged:
        return NA
    if BAD in judged:
        return REVIEW
    if judged.count(WARN) >= 2:
        return CAUTION
    return SOLID


def worse(new: str | None, old: str | None) -> bool:
    """종합이 나빠졌는지 (solid < caution < review). 어느 쪽이든 na·None이면 비교하지 않는다 (False)."""
    return new in _RANK and old in _RANK and _RANK[new] > _RANK[old]


def evaluate(fundamentals: dict | None, *, baseline: dict | None = None, previous: dict | None = None) -> dict:
    """9개 지표 행과 종합 판정.

    fundamentals가 없으면 모든 행이 na(값 null)이고 종합도 na다. baseline이 None이면 기준선 비교를 하지 않는다
    (행의 baseline·change가 늘 null — FundamentalsView, 기준선을 아직 못 잡은 점검). baseline이 dict면 기준선을 쓰는
    지표(BASELINE_KEYS)만 baseline·change를 채운다. previous는 직전 점검(다른 보고서 기간)의 facts.

    돌려주는 facts는 다음 점검의 previous로 쓸 값이다 (매출 성장률, 같은 누적 기간의 순이익·영업현금흐름, 보고서).
    """
    m = metrics(fundamentals)
    rows = []
    for key in KEYS:
        uses = baseline is not None and key in BASELINE_KEYS
        base = _num(baseline.get(key)) if uses else None
        status, note = _judge(key, m, base, previous)
        value = m["values"][key]
        change = round(value - base, 4) if uses and value is not None and base is not None else None
        rows.append({"key": key, "label": LABELS[key], "axis": AXES[key], "value": value, "unit": UNITS[key],
                     "baseline": base if uses else None, "change": change, "status": status, "note": note})
    facts = {"period": m["period"], "revenueGrowth": m["values"]["revenueGrowth"],
             "operatingCashFlow": m["values"]["operatingCashFlow"], "netIncomeSamePeriod": m["netIncomeSamePeriod"]}
    return {"rows": rows, "overall": overall_of(rows), "facts": facts, "period": m["period"],
            "receivedAt": m["receivedAt"]}


def baseline_from(rows: list[dict]) -> dict:
    """점검 행 → 산 이유의 기준선 {지표: 값} (9개 모두, 값이 없으면 null). 판정에는 BASELINE_KEYS 셋만 쓴다."""
    return {r["key"]: r["value"] for r in rows}


def value_text(value: float | None, unit: str) -> str:
    """알림·문장에 넣을 값 표기: ratio 12.3% · times 4.5배 · krw 1,234억원."""
    if value is None:
        return NO_DATA
    if unit == "ratio":
        return _pct(value)
    if unit == "times":
        return f"{value:.1f}배"
    return f"{value / 1e8:,.0f}억원"
