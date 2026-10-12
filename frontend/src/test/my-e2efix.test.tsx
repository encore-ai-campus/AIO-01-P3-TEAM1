// E2E 점검 수정 (W4): UX-13 첫 로그인 닉네임 정하기, UX-18 스위치 누름 영역.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Switch } from "../components/ui";
import * as db from "../mocks/db";
import { renderApp } from "./render";

const prompt = () => screen.queryByRole("region", { name: "랭킹과 리포트에 보일 이름을 정해 주세요" });
const input = () => screen.getByLabelText("랭킹과 리포트에 보일 이름") as HTMLInputElement;

/** 닉네임이 아직 아이디 그대로인 가입 직후 계정으로 만든다. */
function asNewcomer(username: string) {
  db.setSession(username);
  const user = db.sessionUser()!;
  user.nickname = user.username;
}

// '나중에'는 브라우저 저장소에 남는다. 테스트마다 빈 메모리 저장소로 바꾼다 (Node의 localStorage는 쓸 수 없을 수 있다)
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("UX-13 첫 로그인 닉네임", () => {
  it("닉네임이 아이디와 같으면 홈에서 이름을 묻는다 (입력 + 저장 + 나중에)", async () => {
    asNewcomer("bob");
    renderApp("/", "bob");
    const card = await screen.findByRole("region", { name: "랭킹과 리포트에 보일 이름을 정해 주세요" });
    expect(card.textContent).toContain("@bob");
    expect(input()).toBeTruthy();
    expect(screen.getByRole("button", { name: "저장" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "나중에 할게요" })).toBeTruthy();
  });

  it("닉네임을 이미 정한 사람에게는 보이지 않는다", async () => {
    renderApp("/", "alice"); // 앨리스
    await screen.findByRole("navigation", { name: "하단 탭" });
    await waitFor(() => expect(screen.getAllByText("앨리스").length).toBeGreaterThan(0));
    expect(prompt()).toBeNull();
  });

  it("홈이 아닌 화면은 밀지 않는다", async () => {
    asNewcomer("bob");
    renderApp("/my", "bob");
    await screen.findByRole("region", { name: "계정" });
    expect(prompt()).toBeNull();
  });

  it("2~12자가 아니면 칸 아래에 이유를 보이고 저장하지 않는다", async () => {
    asNewcomer("bob");
    renderApp("/", "bob");
    await screen.findByRole("region", { name: "랭킹과 리포트에 보일 이름을 정해 주세요" });
    fireEvent.change(input(), { target: { value: "가" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe("이름은 2~12자로 적어 주세요.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(db.sessionUser()!.nickname).toBe("bob");
  });

  it("다른 팀원과 겹치면 서버가 거절한 이유를 같은 자리에 보이고, 고치면 지운다", async () => {
    asNewcomer("bob");
    renderApp("/", "bob");
    await screen.findByRole("region", { name: "랭킹과 리포트에 보일 이름을 정해 주세요" });
    fireEvent.change(input(), { target: { value: "앨리스" } }); // alice의 닉네임
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe("이미 쓰고 있는 닉네임입니다.");
    fireEvent.change(input(), { target: { value: "앨리스2" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("저장하면 닉네임이 바뀌고 안내가 사라지며 알려 준다", async () => {
    asNewcomer("bob");
    renderApp("/", "bob");
    await screen.findByRole("region", { name: "랭킹과 리포트에 보일 이름을 정해 주세요" });
    fireEvent.change(input(), { target: { value: " 투자왕 " } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(prompt()).toBeNull());
    expect(db.sessionUser()!.nickname).toBe("투자왕");
    expect(screen.getByRole("status").textContent).toContain("'투자왕' 이름으로 보여요");
  });

  it("'나중에 할게요'는 사용자별로 기억한다 — 다시 와도 같은 사람에게는 묻지 않고, 다른 사람에게는 묻는다", async () => {
    asNewcomer("bob");
    const first = renderApp("/", "bob");
    await screen.findByRole("region", { name: "랭킹과 리포트에 보일 이름을 정해 주세요" });
    fireEvent.click(screen.getByRole("button", { name: "나중에 할게요" }));
    expect(prompt()).toBeNull();
    expect(localStorage.getItem(`nickname-prompt-later:${db.sessionUser()!.id}`)).toBe("1");
    expect(db.sessionUser()!.nickname).toBe("bob"); // 이름은 그대로

    first.unmount();
    renderApp("/", "bob");
    await screen.findByRole("navigation", { name: "하단 탭" });
    await waitFor(() => expect(screen.getAllByText("@bob").length).toBeGreaterThan(0));
    expect(prompt()).toBeNull();

    // 같은 브라우저의 다른 계정은 따로 센다
    asNewcomer("dave");
    renderApp("/", "dave");
    expect(await screen.findByRole("region", { name: "랭킹과 리포트에 보일 이름을 정해 주세요" })).toBeTruthy();
  });

  it("브라우저 저장 공간을 못 써도 깨지지 않는다 (이번 방문에만 접는다)", async () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    asNewcomer("bob");
    renderApp("/", "bob");
    await screen.findByRole("region", { name: "랭킹과 리포트에 보일 이름을 정해 주세요" });
    fireEvent.click(screen.getByRole("button", { name: "나중에 할게요" }));
    expect(prompt()).toBeNull();
  });
});

describe("UX-18 스위치 누름 영역", () => {
  it("보이는 트랙은 48×28 그대로, 누르는 입력 칸은 높이 44px(h-11)이고 트랙을 가운데에 둔다", () => {
    const { container } = render(<Switch checked={false} onChange={() => {}} aria-label="시험" />);
    const box = container.querySelector("span.relative")!;
    expect(box.className).toContain("h-7");
    expect(box.className).toContain("w-12");
    const sw = screen.getByRole("switch", { name: "시험" });
    expect(sw.className).toContain("h-11");
    expect(sw.className).toContain("w-full");
    expect(sw.className).toContain("-top-2"); // 28px 트랙 위아래로 8px씩 → 44px
    expect(sw.className).not.toContain("size-full");
    // 포커스 표시는 눈에 보이는 트랙(다음 형제)에 걸린다 — 늘어난 입력 칸에 큰 테두리가 생기지 않는다
    expect(sw.className).toContain("focus-visible:outline-none");
    const track = sw.nextElementSibling!;
    expect(track.className).toContain("peer-focus-visible:outline-2");
  });

  it("늘어난 영역을 눌러도 켜지고 꺼진다 (입력 칸 자체가 누름 대상)", () => {
    let on = false;
    const { rerender } = render(<Switch checked={on} onChange={(v) => (on = v)} aria-label="시험" />);
    fireEvent.click(screen.getByRole("switch", { name: "시험" }));
    expect(on).toBe(true);
    rerender(<Switch checked={on} onChange={(v) => (on = v)} aria-label="시험" />);
    expect((screen.getByRole("switch", { name: "시험" }) as HTMLInputElement).checked).toBe(true);
  });
});
