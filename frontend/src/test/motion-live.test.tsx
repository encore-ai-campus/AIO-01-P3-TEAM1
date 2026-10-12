// 애니메이션이 있는 환경(브라우저)에서만 생기는 '닫히는 중' 상태를 본다.
// jsdom에는 getAnimations가 없어 lib/motion의 CAN_ANIMATE를 true로 바꿔 끼우고, 닫힘 애니메이션은 테스트가 끝낸다
// (finiteAnimations가 돌려주는 가짜 애니메이션). motion.test.tsx는 jsdom 그대로(CAN_ANIMATE false)의 계약을 본다.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Sheet } from "../components/motion/Sheet";

const anim = vi.hoisted(() => ({ finish: () => {} }));

vi.mock("../lib/motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/motion")>();
  return {
    ...actual,
    CAN_ANIMATE: true,
    // 닫힘 애니메이션 하나 — anim.finish()를 부르면 끝난다
    finiteAnimations: () => [
      {
        finished: new Promise<void>((resolve) => {
          anim.finish = resolve;
        }),
      } as unknown as Animation,
    ],
  };
});

describe("Sheet: 닫히는 중 (닫힘 애니메이션이 도는 동안)", () => {
  function Demo({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          산 이유 보기
        </button>
        <button type="button">AI 리포트 만들기</button>
        <Sheet
          open={open}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          labelledBy="thesis-title"
        >
          <h2 id="thesis-title">왜 샀나요?</h2>
          <button type="button" onClick={() => setOpen(false)}>
            취소
          </button>
        </Sheet>
      </>
    );
  }

  it("패널만 잠그고(inert) 배경막은 끝까지 클릭을 받는다 — 아직 보이는 시트를 다시 누른 클릭이 그 뒤 화면의 버튼으로 가지 않게", async () => {
    const onClose = vi.fn();
    render(<Demo onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "산 이유 보기" }));
    fireEvent.click(screen.getByRole("button", { name: "취소" }));

    const root = document.querySelector(".sheet-root")!;
    expect(root.getAttribute("data-state")).toBe("closing"); // 아직 그려져 있다 (내려가는 중)
    expect(root.hasAttribute("inert")).toBe(false); // 층 전체를 inert로 두면 클릭이 층을 지나 아래 화면에 떨어진다
    expect(root.querySelector(".sheet-panel")!.hasAttribute("inert")).toBe(true); // 닫히는 패널 안 버튼은 다시 눌리지 않는다
    const scrim = root.querySelector(".sheet-scrim")!;
    expect(scrim.closest("[inert]")).toBeNull(); // 화면 전체를 덮는 배경막이 클릭을 받는다
    // 닫히는 동안 누르면 배경막이 받아 onClose를 한 번 더 부를 뿐이다 (이미 닫는 중 — 아무 일도 없다)
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(root.getAttribute("data-state")).toBe("closing");

    await act(async () => anim.finish());
    expect(document.querySelector(".sheet-root")).toBeNull();
  });

  it("닫히는 중에 다시 열면 같은 층을 그대로 쓰고 패널 잠금을 푼다", () => {
    render(<Demo onClose={() => {}} />);
    const opener = screen.getByRole("button", { name: "산 이유 보기" });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    const root = document.querySelector(".sheet-root")!;
    expect(root.getAttribute("data-state")).toBe("closing");
    fireEvent.click(opener);
    expect(document.querySelector(".sheet-root")).toBe(root);
    expect(root.getAttribute("data-state")).toBe("open");
    expect(root.querySelector(".sheet-panel")!.hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("dialog", { name: "왜 샀나요?" })).toBeTruthy();
  });
});
