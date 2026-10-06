"""모의 트레이딩 API (docs/API.md "모의 트레이딩"). 로그인은 전역 설정이 확인한다 (안 했으면 401).

시세(Quote·종목 상세)는 실시간이고 (현재가를 받지 못한 종목만 장마감 기준), 계좌 평가·랭킹은 장마감 기준이다.
"""
import math

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from config.api import Rejected, page

from . import market, service
from .models import LONG, SWING, PaperFill, PaperOrder
from .payloads import fill_json, order_json
from .service import ACTIVE, LIMIT, MARKET
from .store import account_for, order_row

MAX_SEARCH, MAX_QUOTES, MAX_EQUITY_DAYS = 50, 50, 365
WEB_STYLES = (SWING, LONG)  # POST /api/orders가 받는 보유 방식


def _int_param(request, key: str, default: int, low: int, high: int) -> int:
    try:
        value = int(request.query_params.get(key, default))
    except (TypeError, ValueError):
        return default
    return min(max(value, low), high)


def _body(request) -> dict:
    if not isinstance(request.data, dict):
        raise Rejected("요청 본문은 JSON 객체여야 합니다.")
    return request.data


def _number(data: dict, key: str, required: bool = False) -> float | None:
    value = data.get(key)
    if value is None:
        if required:
            raise Rejected(f"{key}이(가) 필요합니다.")
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Rejected(f"{key}은(는) 숫자여야 합니다.")
    try:
        number = float(value)
    except OverflowError:  # 자릿수가 아주 긴 정수
        number = math.inf
    if not math.isfinite(number):  # JSON의 1e400은 inf로 읽힌다
        raise Rejected(f"{key}이(가) 너무 큽니다.")
    return number


def _days(data: dict) -> int | None:
    value = _number(data, "days")
    if value is None:
        return None
    if value != int(value):
        raise Rejected("days는 정수여야 합니다.")
    return int(value)


def _style(data: dict) -> str | None:
    """POST /api/orders의 style: 없으면 None (서버가 추론), "swing"·"long"만 받는다 (모르는 값은 400)."""
    value = data.get("style")
    if value is None:
        return None
    if value not in WEB_STYLES:
        raise Rejected("style은 swing 또는 long입니다.")
    return value


def _candle(c: dict) -> dict:
    return {"date": c["timestamp"][:10], "open": float(c["openPrice"]), "high": float(c["highPrice"]),
            "low": float(c["lowPrice"]), "close": float(c["closePrice"]), "volume": float(c["volume"])}


class MarketView(APIView):
    def get(self, request):
        return Response(service.market_status(service.now()))


class StockSearchView(APIView):
    def get(self, request):
        query = request.query_params.get("q", "").strip()
        if not query:
            return Response({"results": []})
        return Response({"results": market.search(query, _int_param(request, "limit", 20, 1, MAX_SEARCH))})


class StockDetailView(APIView):
    def get(self, request, symbol: str):
        """StockDetail (실시간): 일봉은 오늘 진행 중인 봉까지, asOf는 마지막 봉이 진행 중이면 quote.asOf(받은 시각),
        완성 봉이면 그 봉 날짜의 정규장 종료 시각. 현재가를 받지 못해 quote가 장마감 기준이면 전체를 장마감 기준으로
        (일봉은 기준일 이하 완성 봉만)."""
        item = market.stock_item(symbol)
        if item is None:
            raise NotFound("종목을 찾을 수 없습니다.")
        symbol, mkt = item["symbol"], item["market"]
        quote = market.quotes([symbol])[0]
        live = quote["basis"] == market.BASIS_LIVE
        candles = [_candle(c) for c in (market.candles(symbol) if live else market.completed_candles(symbol))]
        as_of = None
        if candles:
            last = candles[-1]["date"]
            as_of = quote["asOf"] if live and market.in_progress(mkt, last) else market.session_end(mkt, last)
        return Response({**item, "currency": market.CURRENCY[mkt], "quote": quote, "candles": candles, "asOf": as_of,
                         "warnings": market.warnings(symbol)})


class QuotesView(APIView):
    def get(self, request):
        symbols = list(dict.fromkeys(s.strip() for s in request.query_params.get("symbols", "").split(",")
                                     if s.strip()))
        if len(symbols) > MAX_QUOTES:
            raise Rejected(f"종목은 한 번에 {MAX_QUOTES}개까지 조회할 수 있습니다.")
        return Response({"quotes": market.quotes(symbols) if symbols else [], "asOf": service.now().isoformat()})


class AccountView(APIView):
    def get(self, request):
        return Response(service.summary(account_for(request.user), service.now()))


class EquityView(APIView):
    def get(self, request):
        days = _int_param(request, "days", 30, 1, MAX_EQUITY_DAYS)
        return Response({"points": service.equity_points(account_for(request.user), days)})


class OrdersView(APIView):
    def get(self, request):
        orders = PaperOrder.objects.filter(account=account_for(request.user)).order_by("-id")
        if request.query_params.get("status", "active") != "all":
            orders = orders.filter(status__in=ACTIVE)
        return page(request, orders, lambda o: order_json(order_row(o)))

    def post(self, request):
        data = _body(request)
        symbol = data.get("symbol")
        if not isinstance(symbol, str) or not symbol.strip():
            raise Rejected("symbol이(가) 필요합니다.")
        order_type = data.get("orderType", MARKET)
        if order_type not in (MARKET, LIMIT):
            raise Rejected("orderType은 MARKET 또는 LIMIT입니다.")
        quantity = _number(data, "quantity", required=True)
        limit = _number(data, "limitPrice", required=order_type == LIMIT)
        style = _style(data)
        try:
            out = service.buy(account_for(request.user), request.user.username, symbol, quantity, order_type, limit,
                              _number(data, "targetPrice"), _number(data, "stopPrice"), _days(data), service.now(),
                              style=style)
        except service.Blocked as e:  # 장기 보유 비중 점검: 사유 코드를 같이 낸다 (docs/API.md "실행 불가 사유 코드")
            return Response(e.body(), status=status.HTTP_400_BAD_REQUEST)
        return Response(out, status=status.HTTP_201_CREATED)


class OrderView(APIView):
    def patch(self, request, order_id: int):
        data = _body(request)
        return Response(service.modify(account_for(request.user), order_id, _number(data, "targetPrice"),
                                       _number(data, "stopPrice"), _days(data), service.now()))


class OrderSellView(APIView):
    def post(self, request, order_id: int):
        return Response(service.sell(account_for(request.user), request.user.username, order_id, service.now()))


class OrderCancelView(APIView):
    def post(self, request, order_id: int):
        return Response(service.cancel(account_for(request.user), request.user.username, order_id, service.now()))


class FillsView(APIView):
    def get(self, request):
        fills = PaperFill.objects.filter(account=account_for(request.user)).select_related("order").order_by("-id")
        return page(request, fills, fill_json)


class ReservationsView(APIView):
    def get(self, request):
        return Response({"results": service.reservations(account_for(request.user))})


class ReservationView(APIView):
    def delete(self, request, reservation_id: int):
        service.delete_reservation(account_for(request.user), reservation_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class RankingView(APIView):
    def get(self, request):
        return Response(service.ranking(request.user, service.now()))
