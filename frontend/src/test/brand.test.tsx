// 로고(ㅁ 블록 셋 — components/brand/BrandMark.tsx): 크기 단계(32px 이상만 속이 빈 ㅁ), 읽기(장식·그림 하나), 색은 토큰 유틸만, 워드마크(세 ㅁ만 brand 색),
// 가로 잠금 규칙(사이 = 마크의 1/4, 워드마크 높이 = 마크의 0.7배), 인트로(BrandIntro·IntroGate: 앱을 열 때 / 또는 /login에서, 눌러서 끝, ?intro=1로 강제, 움직임 줄이기·검수 화면·테스트에서는 건너뜀).
// 쓰는 곳(왼쪽 메뉴·모바일 홈 머리·로그인·부팅 뼈대)은 foundation·shell·App 테스트가 본다.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandIntro } from "../components/brand/BrandIntro";
import { BrandLockup, BrandMark, Wordmark } from "../components/brand/BrandMark";
import { IntroGate } from "../components/brand/IntroGate";
import { SERVICE_INTRO, SERVICE_NAME, SERVICE_TAGLINE } from "../lib/plainText";

/** svg 안 도형: [태그, 칠하는 유틸]. */
const shapes = (svg: Element) => [...svg.children].map((el) => [el.tagName.toLowerCase(), el.getAttribute("class")]);
const COLOR_VALUE = /#[0-9a-f]{3,8}\b|rgba?\(|fill="/i;

describe("로고 (BrandMark)", () => {
  it("기본 32px 장식: 화면 읽기에서 숨고, 타일(brand)과 속이 빈 ㅁ 셋(on-brand)", () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector("svg")!;
    expect([svg.getAttribute("viewBox"), svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["0 0 32 32", "32", "32"]);
    expect([svg.getAttribute("aria-hidden"), svg.getAttribute("role")]).toEqual(["true", null]);
    expect(shapes(svg)).toEqual([
      ["rect", "fill-brand"],
      ["path", "fill-on-brand"],
      ["path", "fill-on-brand"],
      ["path", "fill-on-brand"],
    ]);
    expect(svg.querySelector("rect")!.getAttribute("rx")).toBe("8"); // 모서리 = 크기의 25%
  });

  it("속이 빈 ㅁ은 32px 이상에서만 — 더 작으면 속 구멍이 1배율에서 뭉개져 속이 찬 사각형으로 그린다", () => {
    const { container } = render(
      <>
        <BrandMark size={24} />
        <BrandMark size={31} />
        <BrandMark size={32} />
        <BrandMark size={96} />
      </>,
    );
    const svgs = [...container.querySelectorAll("svg")];
    expect(svgs.map((svg) => [svg.querySelectorAll("path").length, svg.querySelectorAll("rect").length])).toEqual([
      [0, 4],
      [0, 4],
      [3, 1],
      [3, 1],
    ]);
  });

  it("블록은 왼쪽 아래에서 오른쪽 위로 오르는 계단 (같은 도형을 세 번)", () => {
    const { container } = render(<BrandMark size={64} />);
    const [a, b, c] = [...container.querySelectorAll("path")];
    expect(new Set([a, b, c].map((p) => p.getAttribute("d"))).size).toBe(1);
    const ys = [a, b, c].map((p) => Number(/translate\(([\d.]+) ([\d.]+)\)/.exec(p.getAttribute("transform")!)![2]));
    expect(ys).toEqual([...ys].sort((x, y) => y - x)); // 뒤로 갈수록 y가 작다 = 위로 오른다
  });

  it("loop이면 블록마다 <g>로 감싸 계단 순서로 늦춰 튄다. 기본은 감싸지 않는다", () => {
    const { container } = render(
      <>
        <BrandMark size={56} loop />
        <BrandMark size={56} />
      </>,
    );
    const [looping, still] = [...container.querySelectorAll("svg")];
    expect(looping.getAttribute("class")?.split(" ")).toContain("brand-loop");
    expect([...looping.querySelectorAll("g")].map((g) => g.getAttribute("class"))).toEqual(["brand-hop", "brand-hop brand-hop-2", "brand-hop brand-hop-3"]);
    expect(looping.querySelectorAll("g > path")).toHaveLength(3); // 도형 자체의 transform은 그대로 안에 있다
    expect(still.querySelectorAll("g")).toHaveLength(0);
    expect(still.getAttribute("class")?.split(" ")).not.toContain("brand-loop");
  });

  it("label을 주면 그림 하나(role=img)로 읽힌다 — 마크 혼자 링크가 될 때", () => {
    render(<BrandMark label={SERVICE_NAME} />);
    expect(screen.getByRole("img", { name: "모매매" }).getAttribute("aria-hidden")).toBeNull();
  });

  it("색 값을 쓰지 않는다 (hex·rgb·fill 속성 없음 — 토큰 유틸만). 고대비에서도 브랜드 색을 지킨다", () => {
    const { container } = render(
      <>
        <BrandMark size={64} />
        <BrandMark size={24} />
      </>,
    );
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.outerHTML).not.toMatch(COLOR_VALUE);
      expect(svg.getAttribute("class")?.split(" ")).toContain("forced-color-adjust-none");
    }
  });
});

describe("워드마크 (Wordmark)", () => {
  it("장식 SVG: 높이를 주면 폭은 640:175 비율, 세 ㅁ만 brand 색이고 나머지 획은 글자색", () => {
    const { container } = render(<Wordmark height={24} />);
    const svg = container.querySelector("svg")!;
    expect([svg.getAttribute("viewBox"), svg.getAttribute("height"), svg.getAttribute("width"), svg.getAttribute("aria-hidden")]).toEqual([
      "0 0 640 175",
      "24",
      "87.8",
      "true",
    ]);
    expect(svg.querySelectorAll(".fill-brand path")).toHaveLength(3); // 모·매·매의 ㅁ
    expect(svg.querySelectorAll(".fill-current path")).toHaveLength(8); // ㅗ 2획 + ㅐ 3획 × 2
    expect(svg.outerHTML).not.toMatch(COLOR_VALUE);
  });

  it("세 ㅁ은 같은 모양 하나를 복사한 것이다 (크기가 모두 같다)", () => {
    const { container } = render(<Wordmark />);
    const ds = [...container.querySelectorAll(".fill-brand path")].map((p) => p.getAttribute("d"));
    expect(new Set(ds).size).toBe(1);
  });
});

describe("가로 잠금 (BrandLockup)", () => {
  it("마크와 워드마크 사이는 마크의 1/4, 워드마크 높이는 마크의 0.7배. 화면 읽기에는 숨김 이름만 읽힌다", () => {
    const { container } = render(
      <>
        <BrandLockup size={32} className="text-ink" />
        <BrandLockup size={28} className="text-ink" />
      </>,
    );
    const [menu, header] = [...container.children] as HTMLElement[];
    expect([menu.style.gap, header.style.gap]).toEqual(["8px", "7px"]);
    expect([menu.textContent, header.textContent]).toEqual([SERVICE_NAME, SERVICE_NAME]);
    expect(menu.querySelector(".sr-only")?.textContent).toBe(SERVICE_NAME);
    const [menuSvgs, headerSvgs] = [menu, header].map((el) => [...el.querySelectorAll("svg")]);
    expect([menuSvgs[0].getAttribute("width"), menuSvgs[1].getAttribute("height")]).toEqual(["32", "22.4"]);
    expect([headerSvgs[0].getAttribute("width"), headerSvgs[1].getAttribute("height")]).toEqual(["28", "19.6"]);
    expect(menu.className.split(" ")).toContain("text-ink");
  });
});

describe("인트로 (BrandIntro)", () => {
  it("장식이고 길이는 --intro-dur로 준다. 세 ㅁ이 각자 움직이고, 기본은 아이콘이 되는 데까지", () => {
    const { container } = render(<BrandIntro durationMs={5000} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.getAttribute("style")).toContain("--intro-dur: 5000ms");
    expect([...container.querySelectorAll(".intro-b1, .intro-b2, .intro-b3")].map((el) => el.getAttribute("class"))).toEqual([
      "intro-b1 fill-brand",
      "intro-b2 fill-brand",
      "intro-b3 fill-brand",
    ]);
    expect(container.querySelector(".intro-tile")).not.toBeNull();
    expect(container.querySelector(".intro-letters")).not.toBeNull();
    expect(container.querySelector(".intro-name, .intro-shifts")).toBeNull(); // 이름 등장은 lockup일 때만
    expect(container.innerHTML).not.toMatch(COLOR_VALUE);
  });

  it("lockup이면 끝에 아이콘이 밀리고 이름이 나온다", () => {
    const { container } = render(<BrandIntro lockup />);
    expect(container.querySelector(".intro-shifts")).not.toBeNull();
    expect(container.querySelector(".intro-name .fill-brand")).not.toBeNull();
  });

  it("overlay는 화면을 덮고, 자기 애니메이션이 끝나거나 눌리면 onDone (안쪽 도형의 끝은 세지 않는다)", () => {
    const onDone = vi.fn();
    const { container } = render(<BrandIntro overlay durationMs={1600} onDone={onDone} />);
    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay.className.split(" ")).toEqual(expect.arrayContaining(["intro-overlay", "fixed", "inset-0"]));
    // jsdom에는 AnimationEvent가 없어 React가 접두사 이름(webkitAnimationEnd)을 듣는다 — 두 이름을 다 보낸다 (shell.test.tsx의 Flash와 같다)
    const animationEnd = (el: Element) => {
      for (const type of ["animationend", "webkitAnimationEnd"]) fireEvent(el, new Event(type, { bubbles: true }));
    };
    animationEnd(container.querySelector(".intro-tile")!); // 안쪽 도형의 끝은 세지 않는다
    expect(onDone).not.toHaveBeenCalled();
    animationEnd(overlay);
    expect(onDone).toHaveBeenCalledTimes(1);
    fireEvent.click(overlay);
    expect(onDone).toHaveBeenCalledTimes(2);
  });
});

describe("앱 인트로 (IntroGate)", () => {
  const renderAt = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <IntroGate />
      </MemoryRouter>,
    );
  const overlayOf = (path: string) => renderAt(path).container.querySelector(".intro-overlay");

  beforeEach(() => {
    vi.stubEnv("MODE", "development"); // 테스트 모드(MODE=test)에서는 항상 건너뛴다
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("앱을 / 또는 /login으로 열면 로그인 화면 앞에 덮개가 나오고, 눌러서 끝나면 사라진다 (본 기록을 남기지 않는다 — 열 때마다 나온다)", () => {
    const { container, unmount } = renderAt("/login");
    const overlay = container.querySelector(".intro-overlay")!;
    expect(overlay).not.toBeNull();
    // 발표용과 같은 5초 버전(끝에 아이콘 + 이름)을 쓴다 — 앱 전용 짧은 버전은 없다
    expect(overlay.getAttribute("style")).toContain("--intro-dur: 5000ms");
    expect(overlay.querySelector(".intro-name")).not.toBeNull();
    // 인트로가 도는 동안은 아래 화면의 로고 반복 모션을 멈춰 두고(html[data-intro]), 끝나면 푼다
    expect(document.documentElement.dataset.intro).toBe("playing");
    fireEvent.click(overlay);
    expect(container.querySelector(".intro-overlay")).toBeNull();
    expect(document.documentElement.dataset.intro).toBeUndefined();
    unmount();
    expect(overlayOf("/")).not.toBeNull(); // 다시 열면 또 나온다
  });

  it("다른 화면으로 바로 연 주소·디자인 검수 화면(/ui/*)·움직임 줄이기에서는 나오지 않는다", () => {
    expect(overlayOf("/portfolio")).toBeNull();
    expect(overlayOf("/reports/5")).toBeNull();
    expect(overlayOf("/ui/brand")).toBeNull();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(overlayOf("/")).toBeNull();
  });

  it("?intro=1을 붙이면 어느 화면에서든 나온다 (/ui/*와 움직임 줄이기는 그대로 건너뜀)", () => {
    expect(overlayOf("/portfolio?intro=1")).not.toBeNull();
    expect(overlayOf("/portfolio?intro=0")).toBeNull();
    expect(overlayOf("/ui/brand?intro=1")).toBeNull();
  });

  it("테스트 모드에서는 나오지 않는다 (다른 화면 테스트가 덮개에 가리지 않게)", () => {
    vi.unstubAllEnvs();
    expect(overlayOf("/")).toBeNull();
  });
});

describe("이름 문구", () => {
  it("이름은 붙여 쓰고 꾸밈말이 없다. 부제·풀이 한 줄에 쓰지 않는 말(배 은어·띄우다·접다·침몰…)이 없다", () => {
    expect(SERVICE_NAME).toBe("모매매");
    expect(SERVICE_TAGLINE).toBe("여러 AI가 함께 검증하는 모의투자");
    for (const text of [SERVICE_TAGLINE, SERVICE_INTRO]) {
      expect(text).not.toMatch(/탑승|승선|선장|출항|순항|띄우|접[어었다]|침몰|가라앉|구조|\d+배/);
    }
  });
});
