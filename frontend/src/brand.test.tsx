// 로고(종이배 모양 — components/BrandMark.tsx, docs/DECISIONS.md 15-7·18장): 크기 단계(48px 이상만 돛의 접힌 선), 읽기(장식·그림 하나),
// 색은 토큰 유틸만(다크에서 타일이 저절로 밝은 파랑), 가로 잠금 규칙(사이 = 마크의 1/4, 이름 800·자간 -0.02em).
// 쓰는 곳(왼쪽 메뉴·모바일 홈 머리·로그인·부팅 뼈대)은 foundation·shell·App 테스트가 본다.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandLockup, BrandMark } from "./components/BrandMark";
import { SERVICE_INTRO, SERVICE_NAME, SERVICE_TAGLINE } from "./lib/plainText";

/** svg 안 도형: [태그, 칠하는 유틸]. */
const shapes = (svg: Element) => [...svg.children].map((el) => [el.tagName.toLowerCase(), el.getAttribute("class")]);

describe("로고 (BrandMark)", () => {
  it("기본 32px 장식: 화면 읽기에서 숨고, 타일(brand)과 배(on-brand) 두 도형 — 접힌 선은 없다", () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector("svg")!;
    expect([svg.getAttribute("viewBox"), svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["0 0 32 32", "32", "32"]);
    expect([svg.getAttribute("aria-hidden"), svg.getAttribute("role")]).toEqual(["true", null]);
    expect(shapes(svg)).toEqual([
      ["rect", "fill-brand"],
      ["path", "fill-on-brand"],
    ]);
    expect(svg.querySelector("rect")!.getAttribute("rx")).toBe("8"); // 모서리 = 크기의 25%
  });

  it("돛의 접힌 선(타일 색 틈)은 48px 이상에서만 — 더 작으면 1배율에서 얼룩이 된다", () => {
    const { container } = render(
      <>
        <BrandMark size={28} />
        <BrandMark size={47} />
        <BrandMark size={48} />
        <BrandMark size={56} />
      </>,
    );
    const svgs = [...container.querySelectorAll("svg")];
    expect(svgs.map((svg) => svg.querySelectorAll("path").length)).toEqual([1, 1, 2, 2]);
    expect(shapes(svgs[2])[2]).toEqual(["path", "fill-brand"]);
  });

  it("label을 주면 그림 하나(role=img)로 읽힌다 — 마크 혼자 링크가 될 때", () => {
    render(<BrandMark label={SERVICE_NAME} />);
    expect(screen.getByRole("img", { name: "모매매" }).getAttribute("aria-hidden")).toBeNull();
  });

  it("색 값을 쓰지 않는다 (hex·rgb·fill 속성 없음 — 토큰 유틸만). 고대비에서도 브랜드 색을 지킨다", () => {
    const { container } = render(<BrandMark size={64} />);
    const svg = container.querySelector("svg")!;
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|fill="/i);
    expect(svg.getAttribute("class")?.split(" ")).toContain("forced-color-adjust-none");
  });
});

describe("가로 잠금 (BrandLockup)", () => {
  it("마크와 이름 사이는 마크의 1/4, 이름은 800·자간 -0.02em. 화면 읽기에는 이름만 읽힌다", () => {
    const { container } = render(
      <>
        <BrandLockup size={32} className="text-[19px]" />
        <BrandLockup size={28} className="text-[18px]" />
      </>,
    );
    const [menu, header] = [...container.children] as HTMLElement[];
    expect([menu.style.gap, header.style.gap]).toEqual(["8px", "7px"]);
    expect(menu.className.split(" ")).toEqual(expect.arrayContaining(["font-extrabold", "tracking-[-0.02em]", "text-[19px]"]));
    expect([menu.textContent, header.textContent]).toEqual([SERVICE_NAME, SERVICE_NAME]);
    expect([menu, header].map((el) => el.querySelector("svg")!.getAttribute("width"))).toEqual(["32", "28"]);
  });
});

describe("이름 문구", () => {
  it("이름은 붙여 쓰고 꾸밈말이 없다. 부제·풀이 한 줄에 쓰지 않는 말(배 은어·띄우다·접다·침몰…)이 없다", () => {
    expect(SERVICE_NAME).toBe("모매매");
    expect(SERVICE_TAGLINE).toBe("종이 위에서 연습하는 AI 리포트 모의투자");
    for (const text of [SERVICE_TAGLINE, SERVICE_INTRO]) {
      expect(text).not.toMatch(/탑승|승선|선장|출항|순항|띄우|접[어었다]|침몰|가라앉|구조|\d+배/);
    }
  });
});
