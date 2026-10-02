import pytest

from paper_engine.symbols import SymbolError, resolve, resolve_listed

ITEMS = [{"symbol": "FIG", "name": "피그마"}, {"symbol": "005930", "name": "삼성전자"},
         {"symbol": "005935", "name": "삼성전자우"}, {"symbol": "AAPL", "name": "애플"}]


def test_resolve_by_symbol_name_and_unique_partial():
    assert resolve("fig", ITEMS)["symbol"] == "FIG"
    assert resolve("피그마", ITEMS)["symbol"] == "FIG"
    assert resolve("삼성 전자", ITEMS)["symbol"] == "005930"  # 정확히 일치하는 이름이 우선
    assert resolve("전자우", ITEMS)["symbol"] == "005935"


def test_resolve_listed_needs_exact_match():
    assert resolve_listed("aapl", ITEMS)["name"] == "애플"
    assert resolve_listed("삼성전자", ITEMS)["symbol"] == "005930"
    with pytest.raises(SymbolError, match="비슷한 종목: 삼성전자\\(005930\\), 삼성전자우"):
        resolve_listed("삼성", ITEMS)


def test_resolve_errors():
    with pytest.raises(SymbolError, match="없음"):
        resolve("테슬라", ITEMS)
    with pytest.raises(SymbolError, match="여러 개"):
        resolve("삼성", ITEMS)
    with pytest.raises(SymbolError, match="여러 개"):
        resolve_listed("삼성전자", ITEMS + [{"symbol": "X", "name": "삼성 전자"}])
