// 운영 E2E 점검 뒤 고친 리포트 화면 (docs/records/운영E2E점검_UX리뷰_2026-10-08.md UX-4·UX-5·UX-15·UX-17).
// UX-7(진행 화면)·UX-8(지켜보기)은 report-easy.test.tsx의 진행·완성 테스트가 함께 본다.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createChart } from "lightweight-charts";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { Providers } from "../App";
import { AnalysisCard } from "../components/analysis/AnalysisCard";
import { monthStartTickFormatter } from "../lib/chartTicks";
import { createQueryClient } from "../lib/queryClient";
import { REPORT_TERMS, linkTerms } from "../lib/reportTerms";
import * as lib from "../lib/reports";
import * as db from "../mocks/db";
import { renderApp } from "./render";
import { freezeTime } from "./time";

const NOW = "2026-10-06T14:00:00+09:00";

/** 끝난 예시 리포트 셋: NAVER 완성(긍정적, 데이브) · LG에너지솔루션 완성(지켜보기, 에린) · 에코프로 실패(밥). */
function samples() {
  db.addSampleReports();
  const all = db.listReports(null);
  const by = (symbol: string) => all.find((x) => x.symbol === symbol)!;
  return { buy: by("035420"), hold: by("373220"), failed: by("086520") };
}

describe("AI 글 다듬기 (UX-5 화면 안전장치)", () => {
  it("쉼표 없는 원 금액에 쉼표를 넣고, 이미 있거나 원이 아닌 수는 그대로", () => {
    expect(lib.cleanReportText("지지선 187900원에 근접해 이탈 시 201000 원까지")).toBe("지지선 187,900원에 근접해 이탈 시 201,000 원까지");
    expect(lib.cleanReportText("목표 1,234,000원 · 2026년 · 123원 · 0.5000원")).toBe("목표 1,234,000원 · 2026년 · 123원 · 0.5000원");
  });

  it("문장 속 의견 영어를 화면 말로 (바로 붙은 조사도 맞춘다), 영어 문장·다른 낱말은 그대로", () => {
    expect(lib.cleanReportText("AI 의견은 hold예요")).toBe("AI 의견은 지켜보기예요");
    expect(lib.cleanReportText("hold 의견이므로 목표 가격과 진입 가격은 제시하지 않아요")).toBe("지켜보기 의견이므로 목표 가격과 진입 가격은 제시하지 않아요");
    expect(lib.cleanReportText("AI 의견은 sell이에요. sell을 고른 이유")).toBe("AI 의견은 매도예요. 매도를 고른 이유");
    expect(lib.cleanReportText("AI 의견: BUY")).toBe("AI 의견: 매수");
    expect(lib.cleanReportText("Analysts buy the dip · household · Buyback")).toBe("Analysts buy the dip · household · Buyback");
  });

  it("리포트 결과를 읽을 때 쉬운 요약·근거·위험·한 줄 요약·조사 요약에 적용한다 (인용 목록은 그대로)", () => {
    const d = lib.draftOf({
      results: {
        report_agent: {
          verdict: "hold",
          oneLiner: "AI 의견은 hold예요",
          plainSummary: ["201000원 근처예요"],
          reasons: ["hold 의견이므로"],
          risks: ["187900원 아래로 내려가면 다시 봐야 해요"],
          citations: ["hold 리포트"],
          targets: {},
        },
      },
    });
    expect(d).toMatchObject({
      oneLiner: "AI 의견은 지켜보기예요",
      plainSummary: ["201,000원 근처예요"],
      reasons: ["지켜보기 의견이므로"],
      risks: ["187,900원 아래로 내려가면 다시 봐야 해요"],
      citations: ["hold 리포트"],
    });
    expect(lib.researchOf({ results: { market_agent: { summary: "주가는 201000원" } } }).market?.summary).toBe("주가는 201,000원");
  });
});

describe("AI 글의 용어 풀이 (UX-4 화면 쪽)", () => {
  it("화면 순서대로 용어마다 처음 나온 한 번만, 긴 용어를 먼저 ('20일 이동평균선'), 영문 약어는 낱말일 때만", () => {
    const map = linkTerms(["주가는 20일 이동평균선 아래, RSI 32.2", "이동평균선과 RSI가 다시 나오고 PER 13.9배", "PERSONAL 지지선 이탈", null, ""]);
    expect(map.get("주가는 20일 이동평균선 아래, RSI 32.2")).toEqual([
      "주가는 ",
      { key: "이동평균선", text: "20일 이동평균선" },
      " 아래, ",
      { key: "RSI", text: "RSI" },
      " 32.2",
    ]);
    // 이미 나온 이동평균선·RSI는 다시 붙이지 않는다
    expect(map.get("이동평균선과 RSI가 다시 나오고 PER 13.9배")).toEqual(["이동평균선과 RSI가 다시 나오고 ", { key: "PER", text: "PER" }, " 13.9배"]);
    expect(map.get("PERSONAL 지지선 이탈")).toEqual(["PERSONAL ", { key: "지지선", text: "지지선" }, " 이탈"]);
    expect(map.size).toBe(3);
  });

  it("글 안에서 이미 괄호로 풀이한 용어(새 리포트 — 서버가 붙인다)에는 붙이지 않고 뒤에서도 다시 붙이지 않는다, 'RSI(14)'는 풀이가 아니다", () => {
    const map = linkTerms(["주가는 이동평균선(최근 며칠 평균 가격) 아래, RSI(14) 32", "이동평균선 아래로 지지선 (가격이 멈춘 곳) 근처"]);
    expect(map.get("주가는 이동평균선(최근 며칠 평균 가격) 아래, RSI(14) 32")).toEqual([
      "주가는 이동평균선(최근 며칠 평균 가격) 아래, ",
      { key: "RSI", text: "RSI" },
      "(14) 32",
    ]);
    expect(map.get("이동평균선 아래로 지지선 (가격이 멈춘 곳) 근처")).toEqual(["이동평균선 아래로 지지선 (가격이 멈춘 곳) 근처"]);
  });

  it("AI 글 용어 풀이에 권유·단정 표현이 없다", () => {
    for (const e of Object.values(REPORT_TERMS)) expect(e.short).not.toMatch(/사세요|파세요|오를 것|내릴 것|때문에/);
  });

  it("쉬운 보기 리포트: 한 줄 요약의 '수급'·근거의 '20일 이동평균선'을 눌러 풀이, 뒤에 다시 나온 같은 용어에는 붙이지 않는다", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    renderApp(`/reports/${buy.id}`, "bob");
    const conclusion = await screen.findByRole("region", { name: "AI 의견" });
    expect(within(conclusion).getByRole("button", { name: "수급" })).toBeTruthy();
    const reasons = screen.getByRole("list", { name: "근거" });
    fireEvent.click(within(reasons).getByRole("button", { name: "20일 이동평균선" }));
    expect(screen.getByRole("tooltip").textContent).toContain(REPORT_TERMS.이동평균선.short);
    // 위험의 '수급'은 이미 결론에서 풀이했다
    expect(within(screen.getByRole("list", { name: "위험" })).queryByRole("button", { name: "수급" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "수급" })).toHaveLength(1);
  });
});

describe("팀 피드의 실패 리포트 (UX-15)", () => {
  it("남(밥)의 실패 리포트는 팀 리포트에 없다", async () => {
    freezeTime(NOW);
    samples();
    renderApp("/reports", "carol");
    const list = await screen.findByRole("list", { name: "리포트 목록" });
    await waitFor(() => expect(within(list).getByText("NAVER")).toBeTruthy());
    expect(within(list).queryByText("에코프로")).toBeNull();
    expect(lib.inTeamFeed({ status: "failed" }, false)).toBe(false);
    expect(lib.inTeamFeed({ status: "failed" }, true)).toBe(true);
    expect(lib.inTeamFeed({ status: "completed" }, false)).toBe(true);
  });

  it("내 실패 리포트는 팀 리포트에도 남고 '다시 만들기'로 같은 종목을 새로 만든다", async () => {
    freezeTime(NOW);
    const { failed } = samples();
    renderApp("/reports", "bob");
    const list = await screen.findByRole("list", { name: "리포트 목록" });
    await waitFor(() => expect(within(list).getByText(failed.name)).toBeTruthy());
    fireEvent.click(await within(list).findByRole("button", { name: `${failed.name} 다시 만들기` }));
    expect(await screen.findByRole("heading", { name: `${failed.name} AI 리포트` })).toBeTruthy();
    const mine = db.listReports(null).filter((r) => r.symbol === failed.symbol);
    expect(mine.some((r) => r.status !== "failed")).toBe(true);
  });
});

describe("교차검증 판정 한국어 (UX-5)", () => {
  it("전문가 카드도 BUY 매수 · PASS 지켜보기, 계획이 없으면 '제안된 계획이 없어요'", () => {
    db.setSession("alice");
    const all = db.listAnalyses(null, null);
    const wrap = (a: (typeof all)[number]) =>
      render(
        <MemoryRouter>
          <Providers client={createQueryClient({ retry: false })}>
            <AnalysisCard a={a} view="expert" />
          </Providers>
        </MemoryRouter>,
      );
    const buy = wrap(all.find((a) => a.verdict === "BUY")!);
    expect(buy.getByText("매수")).toBeTruthy();
    expect(buy.queryByText("BUY")).toBeNull();
    buy.unmount();
    const pass = wrap(all.find((a) => a.verdict === "PASS" && a.scenarioCount === 0)!);
    expect(pass.getByText("지켜보기")).toBeTruthy();
    expect(pass.getByText("제안된 계획이 없어요.")).toBeTruthy();
    expect(pass.queryByText(/시나리오가 없습니다/)).toBeNull();
  });
});

describe("차트 (UX-17)", () => {
  it("x축: 그 달의 첫 거래일 '날' 눈금은 달 이름, 나머지는 기본 글자", () => {
    const f = monthStartTickFormatter(["2026-05-29", "2026-06-02", "2026-06-03", "2026-07-01"]);
    expect(f("2026-05-29", 2)).toBe("5월"); // 자료의 첫 봉도 그 달의 첫 거래일로 본다
    expect(f("2026-06-02", 2)).toBe("6월");
    expect(f("2026-06-03", 2)).toBeNull();
    expect(f({ year: 2026, month: 7, day: 1 }, 2)).toBe("7월");
    expect(f("2026-06-02", 1)).toBeNull(); // 달·해 눈금은 라이브러리 기본 글자
  });

  it("쉬운 보기 리포트의 가격 흐름은 종가 선 + 달 눈금 (캔들은 전문가 보기에만)", async () => {
    freezeTime(NOW);
    const { hold } = samples();
    vi.mocked(createChart).mockClear();
    renderApp(`/reports/${hold.id}`, "bob");
    expect(await screen.findByRole("img", { name: "종가 선 차트와 계획 가격 선" })).toBeTruthy();
    await waitFor(() => expect(vi.mocked(createChart)).toHaveBeenCalled());
    const options = vi.mocked(createChart).mock.calls.at(-1)?.[1] as { timeScale?: { tickMarkFormatter?: unknown } };
    expect(typeof options.timeScale?.tickMarkFormatter).toBe("function");
    expect(screen.getByRole("region", { name: "가격 흐름" }).textContent).toMatch(/종가/);
  });
});
