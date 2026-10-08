import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Overview } from "./api";
import { costs, engine } from "./mocks/data";
import { server } from "./mocks/server";
import { renderApp } from "./testUtils";

const location = () => screen.getByTestId("location").textContent;

async function login(username: string, password: string) {
  fireEvent.change(await screen.findByLabelText("아이디"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
}

describe("로그인 (F1)", () => {
  it("맞는 계정이면 개요로 들어간다", async () => {
    renderApp("/login", { loggedIn: false });
    await login("admin", "admin1234");
    expect(await screen.findByRole("heading", { name: "개요" })).toBeTruthy();
    expect(location()).toBe("/");
    expect(screen.getByText("admin")).toBeTruthy(); // 위쪽 막대의 로그인한 이름
  });

  it("틀리면 서버의 401 문구를 그대로 보여 준다", async () => {
    renderApp("/login", { loggedIn: false });
    await login("admin", "wrong");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("아이디 또는 비밀번호가 맞지 않거나 관리자 계정이 아닙니다.");
    expect(location()).toBe("/login");
  });

  it("429 문구를 그대로 보여 준다", async () => {
    server.use(http.post("/api/admin/login", () => HttpResponse.json({ detail: "로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도하세요." }, { status: 429 })));
    renderApp("/login", { loggedIn: false });
    await login("admin", "x");
    expect((await screen.findByRole("alert")).textContent).toBe("로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도하세요.");
  });

  it("로그인하지 않고 보호된 화면에 가면 /login으로 보내고, 로그인 뒤 원래 화면으로 돌아간다", async () => {
    renderApp("/costs?x=1", { loggedIn: false });
    await waitFor(() => expect(location()).toBe("/login"));
    await login("admin", "admin1234");
    expect(await screen.findByRole("heading", { name: "AI 비용" })).toBeTruthy();
    expect(location()).toBe("/costs?x=1");
  });

  it("이용 중에 401을 받으면 /login으로 보낸다", async () => {
    server.use(http.get("/api/admin/overview", () => HttpResponse.json({ detail: "로그인이 필요합니다." }, { status: 401 })));
    renderApp("/");
    await waitFor(() => expect(location()).toBe("/login"));
  });

  it("로그아웃하면 /login으로 간다", async () => {
    renderApp("/");
    fireEvent.click(await screen.findByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(location()).toBe("/login"));
  });
});

describe("공통 틀", () => {
  it("503이면 서비스 DB 연결 실패 막대를 보여 준다", async () => {
    server.use(http.get("/api/admin/service", () => HttpResponse.json({ detail: "서비스 DB에 연결할 수 없습니다" }, { status: 503 })));
    renderApp("/service");
    expect((await screen.findByText("서비스 DB에 연결할 수 없습니다", { selector: "div[role=alert]" })).textContent).toBeTruthy();
  });

  it("마지막 갱신 시각과 새로 고침 버튼이 있다", async () => {
    renderApp("/");
    await screen.findByText("엔진 상태");
    expect(screen.getByRole("button", { name: "새로 고침" })).toBeTruthy();
    expect(screen.getByText(/마지막 갱신 \d\d:\d\d:\d\d/)).toBeTruthy();
  });
});

describe("개요 (F2)", () => {
  it("서버가 준 순서 그대로, 레벨 라벨과 함께 보여 준다", async () => {
    const body: Overview = {
      at: new Date().toISOString(),
      level: "down",
      items: [
        { key: "engine", title: "엔진 상태", level: "down", summary: "마지막 동작 5분 전" },
        { key: "costs", title: "AI 비용", level: "warn", summary: "오늘 85%" },
        { key: "recovery", title: "복구 지표", level: "unknown", summary: "장애 없음" },
        { key: "service", title: "서비스 상태", level: "ok", summary: "정상" },
      ],
    };
    server.use(http.get("/api/admin/overview", () => HttpResponse.json(body)));
    renderApp("/");
    const items = await screen.findAllByRole("listitem");
    expect(items.map((li) => li.querySelector("strong")?.textContent)).toEqual(["엔진 상태", "AI 비용", "복구 지표", "서비스 상태"]);
    expect(items.map((li) => li.querySelector(".badge")?.textContent)).toEqual(["멈춤", "주의", "모름", "정상"]);
    expect(within(items[0]).getByRole("link", { name: "자세히" }).getAttribute("href")).toBe("/engine");
  });
});

describe("서비스 (F3)", () => {
  it("가동률·평균 응답과 최근 확인 표를 보여 준다", async () => {
    renderApp("/service");
    expect(await screen.findByText("99.8%")).toBeTruthy();
    const avg = screen.getByText("24시간 평균 응답").closest(".stat") as HTMLElement;
    expect(within(avg).getByText("142ms")).toBeTruthy();
    expect(screen.getAllByText(/page: HTTP 502/).length).toBeGreaterThan(0);
  });
});

describe("엔진 (F4)", () => {
  it("멈춤(stale)이면 크게 '멈춤'으로 표시한다", async () => {
    server.use(http.get("/api/admin/engine", () => HttpResponse.json({ ...engine(), stale: true, ageSec: 400, level: "down" })));
    const { container } = renderApp("/engine");
    await screen.findByText(/6분 40초 전/);
    expect(container.querySelector(".hero-state")?.textContent).toBe("멈춤");
  });

  it("정상이면 동작 중과 단계 오류 표를 보여 준다", async () => {
    const { container } = renderApp("/engine");
    await screen.findByText("news_collect");
    expect(container.querySelector(".hero-state")?.textContent).toBe("동작 중");
    expect(screen.getByText("aiDailyBudgetUsd")).toBeTruthy();
  });
});

describe("배포 (F5)", () => {
  it("서버별 지금 버전을 앞 7자리로 보여 주고 전체는 title에 둔다", async () => {
    renderApp("/deploys");
    const heading = await screen.findByRole("heading", { name: "서버별 지금 버전" });
    const table = heading.nextElementSibling as HTMLElement;
    const row = within(table).getByText("app").closest("tr") as HTMLElement;
    const tag = within(row).getByText("500d087");
    expect(tag.getAttribute("title")).toBe("500d087a4c1f9e2b7d3a68f01c5e9b2d4a7f3c80");
  });

  it("결과 라벨(성공·되돌림·차단)과 실행 링크를 보여 준다", async () => {
    renderApp("/deploys");
    await screen.findByRole("heading", { name: /배포 기록/ });
    expect((await screen.findAllByText("되돌림")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("차단").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "열기" })[0].getAttribute("href")).toMatch(/^https:\/\/github\.com\//);
  });
});

describe("리포트 (F6)", () => {
  it("필터를 바꾸면 쿼리 문자열과 요청 파라미터에 반영된다", async () => {
    const urls: string[] = [];
    server.events.on("request:start", ({ request }) => {
      urls.push(request.url);
    });
    renderApp("/reports");
    await screen.findByText("삼성전자");
    fireEvent.change(screen.getByLabelText("종류"), { target: { value: "failed" } });
    fireEvent.change(screen.getByLabelText("기간"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("팀"), { target: { value: "stock_report" } });
    await waitFor(() => expect(location()).toBe("/reports?kind=failed&days=30&team=stock_report"));
    await waitFor(() => {
      const last = new URL(urls.filter((u) => u.includes("/api/admin/reports?")).at(-1)!);
      expect(last.searchParams.get("kind")).toBe("failed");
      expect(last.searchParams.get("days")).toBe("30");
      expect(last.searchParams.get("team")).toBe("stock_report");
    });
    // 실패한 두 건(SK하이닉스, 삼성바이오로직스)만 남는다
    await waitFor(() => expect(screen.queryByText("삼성전자")).toBeNull());
    expect(screen.getByText("SK하이닉스")).toBeTruthy();
    expect(screen.getByText("삼성바이오로직스")).toBeTruthy();
    server.events.removeAllListeners();
  });

  it("주소의 쿼리 문자열을 필터에 반영하고, 행을 누르면 상세로 간다", async () => {
    renderApp("/reports?days=7&kind=failed");
    await screen.findByText("SK하이닉스");
    expect((screen.getByLabelText("종류") as HTMLSelectElement).value).toBe("failed");
    expect((screen.getByLabelText("기간") as HTMLSelectElement).value).toBe("7");
    fireEvent.click(screen.getByText("SK하이닉스"));
    await waitFor(() => expect(location()).toBe("/reports/107"));
  });

  it("실행 기록 타임라인이 step 순서와 종류 라벨을 보여 준다", async () => {
    renderApp("/reports/108");
    await screen.findByRole("heading", { name: "실행 기록 (시간순)" });
    const rows = (await screen.findAllByRole("row")).slice(1).filter((r) => r.closest("table")?.previousElementSibling?.textContent === "실행 기록 (시간순)");
    const steps = rows.map((r) => Number(within(r).getAllByRole("cell")[0].textContent));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(steps.length).toBe(13);
    const kinds = rows.map((r) => within(r).getAllByRole("cell")[4].textContent);
    expect(kinds).toContain("대체 모델 전환");
    expect(kinds).toContain("재시도");
    expect(kinds).toContain("복구");
    expect(kinds).toContain("실패");
    // 한 줄 상세: errorType · from→to · reason · attempt
    expect(screen.getByText("gemini-3.8-flash → gpt-5.6-luna · reason timeout · attempt 2")).toBeTruthy();
    expect(screen.getByText("errorType timeout · attempt 1")).toBeTruthy();
    // 복구 요약
    expect(screen.getByText("6.0초")).toBeTruthy();
  });

  it("포기한 리포트는 '포기'로 보여 준다", async () => {
    renderApp("/reports/107");
    await screen.findByRole("heading", { name: "실행 기록 (시간순)" });
    expect(screen.getAllByText("포기").length).toBeGreaterThan(0);
    expect(screen.getAllByText("건너뜀").length).toBeGreaterThan(0);
  });

  it("없는 리포트는 404 문구를 보여 준다", async () => {
    renderApp("/reports/9999");
    expect(await screen.findByText("리포트를 찾을 수 없습니다.")).toBeTruthy();
  });
});

describe("복구 지표 (F7)", () => {
  it("자동 복구율과 평균 복구 시간, 최근 장애의 리포트 링크를 보여 준다", async () => {
    renderApp("/recovery");
    expect(await screen.findByText("호출 장애 자동 복구율")).toBeTruthy();
    // 7일 안: 장애 6건(108×2, 107, 105, 102, 103) 중 복구 4건 = 66.7%, 평균 (4200+1800+3100+2600)/4 = 2925ms
    expect(screen.getByText("66.7%")).toBeTruthy();
    expect(screen.getByText("2.9초")).toBeTruthy();
    const link = screen.getAllByRole("link", { name: "#107" })[0];
    expect(link.getAttribute("href")).toBe("/reports/107");
  });
});

describe("AI 비용 (F8)", () => {
  it("오늘 예산 사용 비율과 한도를 보여 준다", async () => {
    renderApp("/costs");
    expect(await screen.findByText("$4.256 / $5.000")).toBeTruthy();
    expect(screen.getByText(/^예산의 85\.1%/)).toBeTruthy();
    expect(screen.getByText("7 / 20")).toBeTruthy();
    expect(screen.getByText("4 / 5")).toBeTruthy();
  });

  it("한도를 모르면(null) '모름'으로 보여 준다", async () => {
    const c = costs(14);
    server.use(
      http.get("/api/admin/costs", () =>
        HttpResponse.json({
          ...c,
          today: { ...c.today, budgetUsd: null, budgetPct: null, analyses: { used: 7, limit: null }, reportsPerUser: { maxUsed: 4, limit: null, unlimited: false } },
        }),
      ),
    );
    renderApp("/costs");
    expect(await screen.findByText("$4.256 / 모름")).toBeTruthy();
    expect(screen.getByText("7 / 모름")).toBeTruthy();
    expect(screen.getByText("4 / 모름")).toBeTruthy();
  });

  it("리포트 한도가 없으면(unlimited) '무제한'으로 보여 준다", async () => {
    const c = costs(14);
    server.use(
      http.get("/api/admin/costs", () =>
        HttpResponse.json({ ...c, today: { ...c.today, reportsPerUser: { maxUsed: 6, limit: null, unlimited: true } } }),
      ),
    );
    renderApp("/costs");
    expect(await screen.findByText("6 / 무제한")).toBeTruthy();
  });

  it("일별 표는 기간의 모든 날을 최근 날부터 보여 주고 기간 합계를 낸다", async () => {
    renderApp("/costs");
    await screen.findByText("기간 합계");
    const body = screen.getAllByRole("row").filter((r) => r.querySelector(".bar-track"));
    expect(body.length).toBe(14);
  });
});

describe("알림 (F9)", () => {
  it("Discord 수치와 멈춘 작업 표를 보여 준다", async () => {
    renderApp("/alerts");
    expect(await screen.findByText("HTTPError: 429 Too Many Requests (https://discord.com/…)")).toBeTruthy();
    expect(screen.getByText("분석 005930")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("기간"), { target: { value: "168" } });
    await waitFor(() => expect((screen.getByLabelText("기간") as HTMLSelectElement).value).toBe("168"));
  });
});

describe("MCP 도구·호출 (F10)", () => {
  it("연결 주소, 도구 9개와 부르는 경로, 토큰의 마지막 사용을 보여 준다", async () => {
    renderApp("/tools");
    expect(await screen.findByText(`${window.location.origin}/mcp`)).toBeTruthy();
    expect(screen.getByText("도구 목록")).toBeTruthy();
    expect(screen.getByText("/api/admin/reports/{report_id}/trace")).toBeTruthy();
    expect(screen.getAllByRole("row").filter((r) => r.textContent?.includes("alerts_and_jobs")).length).toBeGreaterThan(0);
    const yubeen = screen.getAllByRole("row").find((r) => r.textContent?.startsWith("yubeen"));
    expect(yubeen?.textContent).toContain("쓴 적 없음");
  });

  it("호출 기록에 틀린 토큰과 토큰 확인을 구분해 보이고, 도구로 거를 수 있다", async () => {
    renderApp("/tools");
    expect(await screen.findByText("틀린 토큰", { selector: "td span" })).toBeTruthy();
    expect(screen.getAllByText("토큰 확인").length).toBeGreaterThan(0);
    expect(screen.getByText("404")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("도구"), { target: { value: "report_trace" } });
    const callRows = () => screen.getAllByRole("row").filter((r) => r.textContent?.includes("hwanseok"));
    await waitFor(() => expect(callRows().some((r) => r.textContent?.includes("/api/admin/overview"))).toBe(false));
    expect(callRows().every((r) => r.textContent?.includes("report_trace") || !r.querySelector("td code"))).toBe(true);
    expect(screen.getByText("/api/admin/reports/1042/trace")).toBeTruthy();
  });

  it("메뉴에 MCP 도구·호출이 있다", async () => {
    renderApp("/");
    expect(await screen.findByRole("link", { name: "MCP 도구·호출" })).toBeTruthy();
  });
});
