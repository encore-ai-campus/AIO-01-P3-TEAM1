"""종목 찾기. 사용자가 준 종목코드나 종목명을 종목 하나로 정한다 (AI를 쓰지 않는다).

- resolve: 주어진 목록(예: 보유 종목) 안에서 찾는다. 이름 일부가 하나에만 맞으면 그것으로 본다.
- resolve_listed: 전체 종목 목록에서 찾는다 (매수용). 잘못 고르면 모르는 종목을 사게 되므로 정확히 같아야 한다.
"""
MAX_REPORT_DAYS = 90  # 일일 리포트 기간 상한 (일)


class SymbolError(Exception):
    """종목을 하나로 정하지 못함. 메시지를 그대로 사용자에게 보여 준다."""


def _norm(s: str) -> str:
    return "".join(str(s).split()).upper()


def resolve(query: str, items: list[dict]) -> dict:
    """items 중 query에 해당하는 하나. 없거나 여러 개면 SymbolError."""
    q = _norm(query)
    for key in ("symbol", "name"):
        exact = [i for i in items if _norm(i[key]) == q]
        if len(exact) == 1:
            return exact[0]
    partial = [i for i in items if q in _norm(i["name"])]
    if len(partial) == 1:
        return partial[0]
    if not partial:
        raise SymbolError(f"'{query}'에 해당하는 종목이 없음")
    names = ", ".join(f"{i['name']}({i['symbol']})" for i in partial)
    raise SymbolError(f"'{query}'에 해당하는 종목이 여러 개: {names}. 종목코드로 지정하세요")


def resolve_listed(query: str, stocks: list[dict]) -> dict:
    """전체 종목 목록에서 query에 해당하는 하나 (매수용). 종목코드나 종목명이 정확히 같아야 한다.

    매수는 잘못 고르면 모르는 종목을 사게 되므로 부분 일치는 받지 않는다.
    """
    q = _norm(query)
    for key in ("symbol", "name"):
        exact = [s for s in stocks if _norm(s[key]) == q]
        if len(exact) == 1:
            return exact[0]
        if len(exact) > 1:
            names = ", ".join(f"{s['name']}({s['symbol']})" for s in exact)
            raise SymbolError(f"'{query}'에 해당하는 종목이 여러 개: {names}. 종목코드로 지정하세요")
    similar = [s for s in stocks if q in _norm(s["name"])][:5]
    hint = f" 비슷한 종목: {', '.join(f'{s['name']}({s['symbol']})' for s in similar)}" if similar else ""
    raise SymbolError(f"'{query}'과(와) 종목코드나 종목명이 정확히 같은 종목이 없음.{hint}")
