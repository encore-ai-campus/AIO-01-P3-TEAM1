// 가격 사다리의 종가 말풍선 정렬 (trade-r4). 종가가 손절 아래·목표 위면 막대 끝(0%·100%)에 붙는데, 가운데 정렬이면 말풍선 절반이
// 카드·화면 밖으로 나간다 (360px에서 가로 스크롤). 가운데 절반에서는 표시선 가운데, 끝으로 갈수록 끝 정렬로 이어서 바꾼다.
import { cleanup, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PriceLadder } from "./PriceLadder";

/** 손절 180 · 진입 200 · 목표 260 막대에서 종가 말풍선의 위치(left %)와 자기 너비 대비 이동(%). */
function bubble(last: number) {
  render(<PriceLadder stop={180} entry={200} target={260} last={last} currency="KRW" />);
  const el = screen.getByText(/^종가 /).parentElement!;
  const out = { left: parseFloat(el.style.left), shift: parseFloat(el.style.getPropertyValue("--bubble-shift")) };
  cleanup();
  return out;
}

describe("가격 사다리 · 말풍선 이름 (시세의 기준)", () => {
  const ladder = (basis?: "live" | "close", easy = false, last = 300) => {
    render(<PriceLadder stop={180} entry={200} target={260} last={last} basis={basis} currency="KRW" easy={easy} />);
    return screen.getByRole("figure", { name: "가격 사다리" });
  };

  it("기준을 안 주거나 close면 종가, live면 현재가(쉬운 보기는 지금 가격)", () => {
    expect(within(ladder()).getByText("종가 300원")).toBeTruthy();
    cleanup();
    expect(within(ladder("close", true)).getByText("종가 300원")).toBeTruthy();
    cleanup();
    expect(within(ladder("live")).getByText("현재가 300원")).toBeTruthy();
    cleanup();
    expect(within(ladder("live", true)).getByText("지금 가격 300원")).toBeTruthy();
  });

  it("막대 밖 안내도 기준을 따른다 (직전 종가가 / 현재가가 / 지금 가격이)", () => {
    expect(within(ladder()).getByText("직전 종가가 목표가보다 높습니다.")).toBeTruthy();
    cleanup();
    expect(within(ladder("live")).getByText("현재가가 목표가보다 높습니다.")).toBeTruthy();
    cleanup();
    expect(within(ladder("live", true, 100)).getByText("지금 가격이 손절 가격보다 낮아요.")).toBeTruthy();
  });
});

describe("가격 사다리 · 종가 말풍선", () => {
  it("종가가 목표 위면 오른쪽 끝 정렬, 손절 아래면 왼쪽 끝 정렬, 가운데 근처는 표시선 가운데", () => {
    expect(bubble(300)).toEqual({ left: 100, shift: -100 }); // 목표 위 → 막대 끝에 붙고 말풍선은 왼쪽으로 편다
    expect(bubble(100)).toEqual({ left: 0, shift: 0 }); // 손절 아래 → 오른쪽으로 편다
    expect(bubble(220)).toEqual({ left: 50, shift: -50 });
    expect(bubble(260).shift).toBe(-84); // 목표와 같으면(92%) 거의 끝 정렬
    expect(bubble(180).shift).toBe(-16);
  });

  it("말풍선이 막대 폭의 절반 이하면 종가가 어디에 있어도 막대 밖으로 나가지 않는다", () => {
    for (let price = 90; price <= 350; price += 10) {
      const { left, shift } = bubble(price);
      for (const width of [0.2, 0.35, 0.5]) {
        const start = left / 100 + (shift / 100) * width; // 막대 폭 1 기준 말풍선 왼쪽 끝
        expect(start).toBeGreaterThanOrEqual(-1e-9);
        expect(start + width).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});
