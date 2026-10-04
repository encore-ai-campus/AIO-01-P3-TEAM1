// 장기투자 화면 조각: 오늘의 내 종목 뉴스 카드(쉬운·전문가 보기) · 펀더멘털 패널(신호등·지표 표·적용하지 않음·산 이유 점검) · 산 이유 입력.
// 기록일·기준일이 시각에 기대므로 시각을 고정한다 (10월 6일(화) 18:00 KST — 그날 기록이 생긴 뒤).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { Providers } from "./App";
import type { FundamentalsRow, Thesis } from "./api/types";
import { DailyMoveCard } from "./components/longterm/DailyMoveCard";
import { FundamentalsPanel } from "./components/longterm/FundamentalsPanel";
import { axisLine, formatFundamentalChange, formatFundamentalValue, formatKrwShort, orderRows, THESIS_PRESETS } from "./components/longterm/longtermText";
import { ThesisForm } from "./components/longterm/ThesisForm";
import { createQueryClient } from "./lib/queryClient";
import { DAILY_MOVE_CAPTION, DAILY_MOVE_UNCERTAIN, FUNDAMENTALS_CAPTION, FUNDAMENTALS_OVERALL_TEXT } from "./lib/plainText";
import * as db from "./mocks/db";
import { server } from "./mocks/server";
import { freezeTime } from "./test/time";

const TUE_6PM = "2026-10-06T18:00:00+09:00";

/** 우리 문장에 쓰지 않는 표현 (docs/API.md "금지 표현" — 권유 + 시장 설명의 인과 단정·예측). 공백을 지우고 비교한다. */
const FORBIDDEN = [
  ...["사세요", "사볼만", "매수하세요", "매수기회", "지금사면", "담으세요", "좋아요", "파세요", "팔아야", "매도하세요", "매도기회", "지금팔면", "정리하세요", "비중을줄이세요", "비중을늘리세요", "손절하세요"],
  ...["때문에", "덕분에", "원인은", "탓에", "영향으로", "오를것", "내릴것", "오를거", "내릴거", "상승할것", "하락할것", "반등할것"],
];
const forbiddenIn = (text: string) => FORBIDDEN.filter((p) => text.replace(/\s+/g, "").includes(p));

function renderUi(ui: ReactNode, user = "alice") {
  db.setSession(user);
  const client = createQueryClient({ retry: false });
  return render(
    <MemoryRouter>
      <Providers client={client}>{ui}</Providers>
    </MemoryRouter>,
  );
}

const row = (patch: Partial<FundamentalsRow>): FundamentalsRow => ({
  key: "revenueGrowth",
  label: "매출 성장",
  axis: "growth",
  value: 0.1,
  unit: "ratio",
  baseline: null,
  change: null,
  status: "ok",
  note: null,
  ...patch,
});

describe("장기투자 표시 규칙", () => {
  it("값: 성장률은 부호, 그 밖 비율은 %, 배, 큰 원화는 조·억", () => {
    expect(formatFundamentalValue(row({}), 0.123)).toBe("+12.3%");
    expect(formatFundamentalValue(row({}), -0.142)).toBe("−14.2%");
    expect(formatFundamentalValue(row({ key: "debtRatio" }), 1.5)).toBe("150.0%");
    expect(formatFundamentalValue(row({ key: "interestCoverage", unit: "times" }), 3.25)).toBe("3.3배");
    expect(formatFundamentalValue(row({ key: "operatingCashFlow", unit: "krw" }), 1.23e12)).toBe("1.2조 원");
    expect(formatKrwShort(-3.4e10)).toBe("−340억 원");
    expect(formatFundamentalValue(row({}), null)).toBe("-");
  });

  it("변화: 비율은 %p", () => {
    expect(formatFundamentalChange(row({ change: -0.034 }))).toBe("−3.4%p");
    expect(formatFundamentalChange(row({ change: 0.02 }))).toBe("+2.0%p");
    expect(formatFundamentalChange(row({ change: null }))).toBe("-");
  });

  it("축 순서는 고른 축이 먼저 (판정은 그대로), 축별 한 줄", () => {
    const rows = [row({ key: "debtRatio", axis: "balance_sheet", status: "bad" }), row({ status: "ok" }), row({ key: "roe", axis: "profitability", status: "warn" })];
    expect(orderRows(rows, ["profitability"]).map((r) => r.key)).toEqual(["roe", "debtRatio", "revenueGrowth"]);
    expect(orderRows(rows, []).map((r) => r.status)).toEqual(["bad", "ok", "warn"]);
    expect(axisLine(rows, "balance_sheet")).toBe("재무 안정: 확인 필요 1");
    expect(axisLine([row({ status: "na" })], "growth")).toBe("성장: 판정한 지표 없음");
  });

  it("산 이유 예시에는 권유 표현이 없다", () => {
    expect(forbiddenIn(THESIS_PRESETS.join(" "))).toEqual([]);
  });
});

describe("<DailyMoveCard>", () => {
  it("쉬운 보기: 세 숫자(시장 KODEX 기준·업종 자료 없음·내 종목) + 설명 + 고정 문구 · 국내 종목만 · 장마감 기준", async () => {
    freezeTime(TUE_6PM);
    const expected = db.dailyMoves(1, null);
    expect(expected.results.map((m) => m.name)).toEqual(["삼성전자", "셀트리온"]); // 앨리스의 국내 보유 (이름순)
    renderUi(<DailyMoveCard view="easy" />);
    const first = await screen.findByRole("article", { name: "삼성전자 오늘의 뉴스" });
    expect(screen.getByRole("heading", { name: /오늘의 내 종목 뉴스/ }).textContent).toContain("10월 6일(화)");
    expect(screen.getByText("국내 종목만")).toBeTruthy();
    expect(screen.getByText(DAILY_MOVE_CAPTION)).toBeTruthy();

    const m = expected.results[0];
    const three = within(first).getByLabelText("삼성전자 세 숫자");
    expect(three.textContent).toContain(`시장(${m.marketProxy.name} 기준)`);
    expect(three.textContent).toContain("업종자료 없음");
    expect(three.textContent).toContain("내 종목");
    expect(within(first).getByText(m.headline)).toBeTruthy();
    expect(within(first).getByText("10월 6일(화) 15:30 장마감 기준")).toBeTruthy();
    for (const s of m.summary.slice(0, 3)) expect(within(first).getByText(s)).toBeTruthy();
    expect(within(first).queryByText(DAILY_MOVE_UNCERTAIN) !== null).toBe(m.uncertain);
    // 근거는 접어서 (출처·시각)
    const details = within(first).getByText(/같은 날 나온 소식 \d+개/).closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText(/출처: 연합뉴스/)).toBeTruthy();
    expect(screen.queryByText("시장 대비 초과 등락")).toBeNull();
    expect(forbiddenIn(document.body.textContent ?? "")).toEqual([]);
  });

  it("전문가 보기: 등락 분해 · 수급 비율 · 근거 목록(출처·시각·공시 원문) · 비운 칸", async () => {
    freezeTime(TUE_6PM);
    const expected = db.dailyMoves(1, null).results;
    renderUi(<DailyMoveCard view="expert" />);
    for (const m of expected) {
      const art = await screen.findByRole("article", { name: `${m.name} 오늘의 뉴스` });
      const split = within(art).getByLabelText(`${m.name} 등락 분해`);
      expect(split.textContent).toContain(`시장 (${m.marketProxy.name} 기준)`);
      expect(within(split).getByRole("button", { name: "시장 대비 초과 등락" })).toBeTruthy();
      expect(split.textContent).toContain("업종자료 없음");
      expect(split.textContent).toContain("20일 변동성");
      expect(art.textContent).toContain("외국인");
      expect(art.textContent).toContain("기관");
      expect(art.textContent).toContain("개인");
      const evidence = within(art).getByRole("list", { name: "같은 날 나온 소식" });
      expect(within(evidence).getAllByRole("listitem")).toHaveLength(m.evidence.length);
      for (const e of m.evidence) {
        expect(evidence.textContent).toContain(e.id);
        expect(evidence.textContent).toContain(`출처: ${e.source}`);
      }
      const dart = m.evidence.find((e) => e.url);
      const link = within(evidence).queryByRole("link", { name: "공시 원문" });
      expect(link?.getAttribute("href") ?? null).toBe(dart?.url ?? null);
      expect(within(art).getByRole("list", { name: "비운 칸" }).textContent).toContain("업종: 업종 자료 없음");
      expect(art.textContent).toContain(m.method === "llm" ? "AI 설명 (검사 통과)" : "정해진 문장 (AI 설명 아님)");
    }
    expect(screen.getByText(DAILY_MOVE_CAPTION)).toBeTruthy();
  });

  it("limit만큼 보이고, 나머지는 '외 N종목 더 보기'로 펼쳐 볼 수 있다", async () => {
    freezeTime(TUE_6PM);
    renderUi(<DailyMoveCard view="easy" limit={1} />);
    expect(await screen.findByRole("article", { name: "삼성전자 오늘의 뉴스" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "셀트리온 오늘의 뉴스" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "외 1종목 더 보기" }));
    expect(screen.getByRole("article", { name: "셀트리온 오늘의 뉴스" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /더 보기/ })).toBeNull();
  });

  it("보유한 국내 종목의 기록이 없으면 빈 안내 (고정 문구는 그대로)", async () => {
    freezeTime(TUE_6PM);
    renderUi(<DailyMoveCard view="easy" />, "bob");
    expect(await screen.findByText(/보유 중인 국내 종목의 기록이 아직 없어요/)).toBeTruthy();
    expect(screen.getByText(DAILY_MOVE_CAPTION)).toBeTruthy();
    expect(screen.getByText("국내 종목만")).toBeTruthy();
  });
});

describe("<FundamentalsPanel>", () => {
  it("쉬운 보기: 신호등(중립 표기) + 한 줄 + 축별 한 줄 + 고정 문구·출처·보고서", async () => {
    freezeTime(TUE_6PM);
    const f = db.fundamentals(1, "068270");
    renderUi(<FundamentalsPanel symbol="068270" view="easy" />);
    expect(await screen.findByLabelText(`종합 판정: ${FUNDAMENTALS_OVERALL_TEXT[f.overall]}`)).toBeTruthy();
    const axes = screen.getAllByRole("list", { name: "축별 판정" })[0];
    // 내 산 이유의 축(성장·수익성)이 먼저
    expect(within(axes).getAllByRole("listitem").map((li) => li.textContent?.split(":")[0])).toEqual(["성장", "수익성", "재무 안정"]);
    expect(screen.getAllByText(FUNDAMENTALS_CAPTION).length).toBeGreaterThan(0);
    expect(screen.getByText(/출처: 금융감독원 OpenDART · 2026 반기보고서 \(접수 2026\.08\.14\)/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    for (const bad of ["견조", "점검 필요"]) expect(document.body.textContent).not.toContain(bad);
    expect(forbiddenIn(document.body.textContent ?? "")).toEqual([]);
  });

  it("전문가 보기: 9개 지표 표(값·판정·메모), 용어 풀이, 기준선 열은 기준선이 있을 때만", async () => {
    freezeTime(TUE_6PM);
    renderUi(<FundamentalsPanel symbol="086520" view="expert" />);
    const table = await screen.findByRole("table", { name: "에코프로 펀더멘털 지표" });
    expect(within(table).getAllByRole("row")).toHaveLength(10); // 머리 + 9
    expect(within(table).getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["지표", "값", "판정", "메모"]);
    const margin = within(table).getByRole("button", { name: "영업이익률(TTM)" }).closest("tr")!;
    expect(margin.textContent).toContain("-4.2%");
    expect(margin.textContent).toContain("확인 필요");
    expect(margin.textContent).toContain("영업이익률이 음수");
    expect(screen.getByLabelText("종합 판정: 확인 필요")).toBeTruthy();
    expect(screen.getByText(/2026 반기보고서/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "내 산 이유" })).toBeNull(); // 앨리스는 이 종목 산 이유가 없다
  });

  it("적용하지 않는 종목은 이유 한 줄과 고정 문구만", async () => {
    freezeTime(TUE_6PM);
    renderUi(<FundamentalsPanel symbol="105560" view="easy" />);
    expect(await screen.findByLabelText("종합 판정: 적용하지 않음")).toBeTruthy();
    expect(screen.getByText("금융업은 일반 기업용 점검을 적용하지 않아요")).toBeTruthy();
    expect(screen.getByText(FUNDAMENTALS_CAPTION)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("list", { name: "축별 판정" })).toBeNull();
  });

  it("내 산 이유와 최근 점검 — 전문가 보기는 기준선 비교 표, 고치기를 누르면 입력 폼", async () => {
    freezeTime(TUE_6PM);
    const thesis = db.fundamentals(1, "068270").thesis!;
    renderUi(<FundamentalsPanel symbol="068270" view="expert" />);
    const mine = await screen.findByRole("group", { name: "내 산 이유" });
    for (const r of thesis.reasons) expect(within(mine).getByText(r)).toBeTruthy();
    expect(mine.textContent).toContain(`최근 점검: ${FUNDAMENTALS_OVERALL_TEXT[thesis.lastCheck!.overall]}`);
    expect(mine.textContent).toContain("점검 축: 성장 · 수익성");
    const table = within(mine).getByRole("table", { name: "산 이유 점검 지표 (기준선 비교)" });
    expect(within(table).getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["지표", "값", "기준선", "변화", "판정", "메모"]);
    const margin = within(table).getByRole("button", { name: "영업이익률(TTM)" }).closest("tr")!;
    const r = thesis.lastCheck!.rows.find((x) => x.key === "operatingMargin")!;
    expect(margin.textContent).toContain(formatFundamentalChange(r));

    fireEvent.click(within(mine).getByRole("button", { name: "산 이유 고치기" }));
    const form = screen.getByRole("form", { name: "셀트리온 산 이유" });
    expect(within(within(form).getByRole("list", { name: "내 이유" })).getAllByRole("listitem")).toHaveLength(thesis.reasons.length);
    expect((within(form).getByRole("checkbox", { name: "성장" }) as HTMLInputElement).checked).toBe(true);
    expect((within(form).getByRole("checkbox", { name: "재무 안정" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(form).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("form", { name: "셀트리온 산 이유" })).toBeNull();
  });

  it("고친 산 이유를 저장하면 패널에 바로 보인다", async () => {
    freezeTime(TUE_6PM);
    renderUi(<FundamentalsPanel symbol="068270" view="easy" />);
    fireEvent.click(await screen.findByRole("button", { name: "산 이유 고치기" }));
    const form = screen.getByRole("form", { name: "셀트리온 산 이유" });
    fireEvent.click(within(form).getByRole("button", { name: /"신약 개발 일정이 공개돼 있어서" 지우기/ }));
    fireEvent.click(within(form).getByRole("button", { name: "산 이유 저장" }));
    const mine = await screen.findByRole("group", { name: "내 산 이유" });
    await waitFor(() => expect(within(mine).queryByRole("form")).toBeNull());
    expect(within(mine).queryByText("신약 개발 일정이 공개돼 있어서")).toBeNull();
    expect(db.listTheses(1).find((t) => t.symbol === "068270")!.reasons).toEqual(["바이오시밀러 해외 판매가 늘고 있어서"]);
  });
});

describe("<ThesisForm>", () => {
  it("예시를 고르고 직접 적고 축을 골라 저장 (PUT) → onSaved", async () => {
    freezeTime(TUE_6PM);
    const onSaved = vi.fn<(t: Thesis) => void>();
    renderUi(<ThesisForm symbol="005930" name="삼성전자" onSaved={onSaved} />);
    expect(screen.getByRole("heading", { name: "왜 샀나요?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "취소" })).toBeNull(); // onCancel이 없으면 취소 버튼도 없다
    const save = screen.getByRole("button", { name: "산 이유 저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const preset = screen.getByRole("button", { name: THESIS_PRESETS[0] });
    fireEvent.click(preset);
    expect(preset.getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("직접 적기"), { target: { value: "  반도체 업황 지표를 공부하려고  " } });
    fireEvent.click(screen.getByRole("button", { name: "추가" }));
    expect(within(screen.getByRole("list", { name: "내 이유" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      THESIS_PRESETS[0],
      "반도체 업황 지표를 공부하려고",
    ]);
    fireEvent.click(screen.getByRole("checkbox", { name: "수익성" }));
    fireEvent.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0][0]).toMatchObject({ symbol: "005930", reasons: [THESIS_PRESETS[0], "반도체 업황 지표를 공부하려고"], axes: ["profitability"] });
    expect(db.listTheses(1).find((t) => t.symbol === "005930")).toMatchObject({ axes: ["profitability"] });
  });

  it("이유는 3개까지, 한 개에 100자까지 (적다 만 이유는 저장할 때 같이 넣는다)", async () => {
    freezeTime(TUE_6PM);
    const onSaved = vi.fn();
    renderUi(<ThesisForm symbol="005930" name="삼성전자" onSaved={onSaved} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("직접 적기"), { target: { value: "가".repeat(101) } });
    fireEvent.click(screen.getByRole("button", { name: "추가" }));
    expect(screen.getByRole("alert").textContent).toContain("100자까지");
    fireEvent.change(screen.getByLabelText("직접 적기"), { target: { value: "" } });

    for (const p of THESIS_PRESETS.slice(0, 2)) fireEvent.click(screen.getByRole("button", { name: p }));
    fireEvent.change(screen.getByLabelText("직접 적기"), { target: { value: "세 번째 이유" } });
    fireEvent.click(screen.getByRole("button", { name: "산 이유 저장" })); // 적다 만 세 번째도 같이
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0][0].reasons).toEqual([...THESIS_PRESETS.slice(0, 2), "세 번째 이유"]);
    expect(onSaved.mock.calls[0][0].axes).toEqual([]); // 고르지 않으면 [] (셋 다)
    // 3개가 차면 다른 예시와 직접 적기가 막힌다
    expect((screen.getByRole("button", { name: THESIS_PRESETS[3] }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("직접 적기") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "취소" })).toBeTruthy();
  });

  it("서버 400이면 detail을 보이고 onSaved를 부르지 않는다", async () => {
    freezeTime(TUE_6PM);
    server.use(http.put("*/api/longterm/theses/:symbol", () => HttpResponse.json({ detail: "점검 축이 올바르지 않습니다." }, { status: 400 })));
    const onSaved = vi.fn();
    renderUi(<ThesisForm symbol="005930" name="삼성전자" initial={{ reasons: ["이미 적은 이유"], axes: ["growth"] }} onSaved={onSaved} />);
    expect((screen.getByRole("checkbox", { name: "성장" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "산 이유 저장" }));
    expect(await screen.findByText("점검 축이 올바르지 않습니다.")).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
