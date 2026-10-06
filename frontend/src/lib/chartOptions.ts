// 차트(lightweight-charts) 손동작 — 두 차트(종목 일봉 CandleChart · 쉬운 리포트 ReportChart)가 같이 쓴다.
// 차트는 긴 세로 화면 한가운데 있다. 차트 위에서 휠을 굴리거나 세로로 쓸어도 페이지가 내려가야 한다 (차트가 스크롤을 먹지 않게).
// 차트는 끌기(마우스·가로 터치) · 두 손가락 벌리기 · 시간 축 끌기 · Ctrl/⌘ + 휠(트랙패드 두 손가락 벌리기 포함)로만 움직인다.
// 색은 lib/chartTheme.ts. 이 파일은 색을 다루지 않는다.
import type { IChartApi, LineStyle } from "lightweight-charts";

/**
 * createChart 옵션에 펼쳐 쓴다: createChart(el, { …, ...CHART_INTERACTION }). 차트를 만든 뒤 zoomWheelWithModifier(el, chart)를 붙인다.
 * - 휠: 차트가 받지 않는다 (페이지 스크롤). Ctrl/⌘ + 휠일 때만 확대 — zoomWheelWithModifier가 그 휠마다 켜고 끈다.
 * - 터치: 가로로 끌면 기간을 옮기고, 세로로 쓸면 페이지가 내려간다. 두 손가락 벌리기는 확대.
 * - 축: 시간 축만 끌어 넓힌다 (가격 축을 끌면 가격 선·표시가 어긋나 보인다). 두 번 누르면 처음 범위로.
 */
export const CHART_INTERACTION = {
  handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: { time: true, price: false }, axisDoubleClickReset: true },
} as const;

/** 점선 (LineStyle.Dashed — 값만 쓴다. 테스트의 차트 가짜 모듈에는 열거형이 없다). */
export const DASHED = 2 as LineStyle;

/** 이보다 좁은 차트는 가격 선 이름을 빼고 축 라벨(값)만 둔다. */
export const NARROW_CHART_PX = 480;

/**
 * 가격 선(사는·목표·손절) 이름. 좁은 차트(모바일)에서는 빈 이름 — 이름 상자가 오른쪽 끝의 최근 봉과 체결 표시(청산 화살표 등)를 가린다.
 * 이름과 값은 차트 아래 범례가 늘 보인다. 폭을 모르면(0 — 테스트·숨김) 넓은 차트로 본다.
 */
export function lineTitle(el: HTMLElement | null, title: string): string {
  const width = el?.clientWidth ?? 0;
  return width > 0 && width < NARROW_CHART_PX ? "" : title;
}

/**
 * Ctrl/⌘ + 휠일 때만 차트가 휠로 확대한다. 휠이 차트까지 내려가기 전(capture)에 그 휠의 Ctrl/⌘ 여부로 차트의 휠 확대를 켜고 끈다
 * (차트는 휠을 받은 순간의 옵션을 읽는다). 바뀔 때만 applyOptions를 부른다.
 * - 보통 휠: 차트가 무시하고 기본 동작을 막지 않는다 → 페이지 스크롤.
 * - Ctrl/⌘ 휠: 차트가 기본 동작을 막고 확대한다 → 브라우저 화면 확대 대신 차트 확대.
 * 이벤트를 멈추지 않는다(stopPropagation 없음): 페이지의 다른 휠 듣기(뒤로 가기 뒤 스크롤 복원 중단 등)도 그대로 받는다.
 * passive가 아닌 이유: 차트가 휠을 듣지 않는 동안 이 자리에 '막을 수 있는' 휠 듣기가 하나도 없으면 브라우저가 휠을 막을 수 없는 것으로 보내고,
 * 그러면 Ctrl/⌘ 휠(트랙패드 벌리기)이 차트 대신 화면 전체를 확대한다. 이 함수는 기본 동작을 막지 않는다.
 * 돌려주는 함수로 뗀다 (차트를 지울 때 같이).
 */
export function zoomWheelWithModifier(el: HTMLElement, chart: Pick<IChartApi, "applyOptions">): () => void {
  let zoom: boolean = CHART_INTERACTION.handleScale.mouseWheel;
  const onWheel = (e: WheelEvent) => {
    const want = e.ctrlKey || e.metaKey;
    if (want === zoom) return;
    zoom = want;
    chart.applyOptions({ handleScale: { mouseWheel: want } });
  };
  el.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => el.removeEventListener("wheel", onWheel, { capture: true });
}
