// 일봉 차트(lightweight-charts)의 x축 눈금 글자 — 종목 일봉(CandleChart)·쉬운 리포트(ReportChart)가 같이 쓴다 (UX-17).
// 라이브러리는 자료의 첫 봉처럼 앞 봉이 없는 자리의 월 경계를 '날'로 세어 "6월" 대신 "2일"을 쓴다.
// 그래서 자료에서 그 달의 첫 거래일이면 날 대신 달("6월")을 쓴다. 해·달 눈금과 다른 날은 라이브러리 기본 글자(ko-KR) 그대로다.
import type { Time } from "lightweight-charts";

/** TickMarkType.DayOfMonth (값만 쓴다 — 테스트의 차트 가짜 모듈에는 열거형이 없다). */
const DAY_OF_MONTH = 2;

/** 눈금의 시각 → "YYYY-MM-DD" (일봉은 날짜 글자나 BusinessDay로 온다). 모르면 null. */
function dayOf(time: Time): string | null {
  if (typeof time === "string") return time.slice(0, 10);
  if (typeof time === "object" && time !== null) {
    return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
  }
  return null;
}

/**
 * 일봉 날짜(오름차순)로 x축 눈금 글자 함수를 만든다: 그 달의 첫 거래일 '날' 눈금은 "6월", 나머지는 null(기본 글자).
 * createChart·applyOptions의 timeScale.tickMarkFormatter에 넣는다.
 */
export function monthStartTickFormatter(days: readonly string[]): (time: Time, tickMarkType: number) => string | null {
  const firsts = new Set<string>();
  let month = "";
  for (const d of days) {
    const ym = d.slice(0, 7);
    if (ym !== month) {
      firsts.add(d.slice(0, 10));
      month = ym;
    }
  }
  return (time, tickMarkType) => {
    if (tickMarkType !== DAY_OF_MONTH) return null;
    const day = dayOf(time);
    if (day === null || !firsts.has(day)) return null;
    return `${Number(day.slice(5, 7))}월`;
  };
}
