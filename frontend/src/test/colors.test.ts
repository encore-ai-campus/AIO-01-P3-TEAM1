// 하드코딩 색 가드: 색은 index.css의 토큰 유틸(bg-card, text-warn-ink, bg-scrim …)로만 쓴다 — 다크 모드에서 깨지지 않게.
// 검사: src의 .ts·.tsx(테스트·mocks·test/ 제외)에 #rgb·#rrggbb·#rrggbbaa·rgb()·rgba()·bg-white·bg-black이 없어야 한다.
// text-white는 검사하지 않는다 (brand·up·down·ok 버튼 위 흰 글자는 두 테마에서 그대로 맞다).
import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../mocks/**", "!../test/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** 색 상수를 둘 수밖에 없는 파일: 차트 대체값(캔버스는 CSS 변수를 모른다), 첫 페인트·meta theme-color 값(index.html과 같아야 한다). */
const ALLOWED = new Set(["lib/chartTheme.ts", "lib/theme.ts"]);

/**
 * 아직 고치지 않은 파일 (기반 작업 F1 시점). 각 영역이 자기 파일의 색을 토큰으로 바꾼 뒤 여기서 그 줄만 지운다.
 * 모든 작업이 끝나면 비어야 한다. 고친 파일이 남아 있으면 아래 '목록 정리' 테스트가 알려 준다.
 */
const PENDING: string[] = [];

const PATTERNS: RegExp[] = [
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z_-])/, // #rrggbb·#rrggbbaa
  /(?:[[("'`]|:\s*)#[0-9a-fA-F]{3,4}(?![0-9a-zA-Z_-])/, // #rgb·#rgba는 색 자리에서만 ('리포트 #123' 같은 번호는 빼려고)
  /\b(?:rgba?|hsla?|oklch|oklab)\(/,
  /\bbg-(?:white|black)\b/,
];

const files = Object.entries(SOURCES)
  .map(([path, text]) => ({ path: path.replace(/^\.\.\//, ""), text }))
  .filter((f) => !ALLOWED.has(f.path));

/** 위반 줄: "파일:줄: 내용" */
function violations(path: string, text: string): string[] {
  return text
    .split("\n")
    .flatMap((line, i) => (PATTERNS.some((re) => re.test(line)) ? [`${path}:${i + 1}: ${line.trim()}`] : []));
}

describe("하드코딩 색 가드", () => {
  it("검사할 소스를 실제로 읽는다", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.path === "components/Layout.tsx")).toBe(true);
    expect(files.some((f) => f.path.includes("mocks/") || f.path.endsWith(".test.ts") || f.path.endsWith(".test.tsx"))).toBe(false);
  });

  it("정규식이 색만 잡는다 (문구 속 번호는 잡지 않는다)", () => {
    const hit = (s: string) => PATTERNS.some((re) => re.test(s));
    for (const s of ['hover:bg-[#fafbfc]', 'text-[#9a5b00]', 'color: "#191F28"', "'#fff'", "bg-[#0006]", "fill: #ffffff80", "rgba(0,0,0,.4)", "bg-white/20", "bg-black/40"]) {
      expect(hit(s), s).toBe(true);
    }
    for (const s of ["리포트 #123을 열어요", "주문 #42", "bg-card text-ink", "text-white", "bg-scrim", "href={`#${id}`}"]) {
      expect(hit(s), s).toBe(false);
    }
  });

  it("목록(PENDING)에 없는 파일에는 하드코딩 색이 없다 — 색은 index.css 토큰으로", () => {
    const pending = new Set(PENDING);
    const found = files.filter((f) => !pending.has(f.path)).flatMap((f) => violations(f.path, f.text));
    expect(found).toEqual([]);
  });

  it("목록 정리: 고친 파일·없는 파일은 PENDING에서 지운다", () => {
    const byPath = new Map(files.map((f) => [f.path, f.text]));
    const stale = PENDING.filter((p) => {
      const text = byPath.get(p);
      return text === undefined || violations(p, text).length === 0;
    });
    expect(stale).toEqual([]);
    expect(new Set(PENDING).size).toBe(PENDING.length);
  });
});
