import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { ChaosConfigRequest } from "./api";
import { createMockChaosRun, trace } from "./mocks/data";
import { server } from "./mocks/server";
import { renderApp } from "./testUtils";

// F11 장애 주입 (API.md 7장): /chaos 신청 화면과 리포트 상세의 3초 갱신·"같은 설정으로 다시".

const location = () => screen.getByTestId("location").textContent;
type Body = { symbol: string; chaos: ChaosConfigRequest };

/** 신청 본문을 모으고 가짜 서비스처럼 실행을 만든다 (그래서 이동한 상세 화면도 그려진다). */
function captureRuns(): Body[] {
  const bodies: Body[] = [];
  server.use(
    http.post("/api/admin/chaos/runs", async ({ request }) => {
      const body = (await request.json()) as Body;
      bodies.push(body);
      return HttpResponse.json(createMockChaosRun(body.symbol, body.chaos, "admin"), { status: 201 });
    }),
  );
  return bodies;
}

async function openForm() {
  renderApp("/chaos");
  await screen.findByLabelText("응답 지연 (timeout)"); // 고르기 목록(options)을 받았다
}

const preset = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const radio = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const runButton = () => screen.getByRole("button", { name: "실행" });

describe("장애 주입 (F11)", () => {
  it("메뉴의 장애 주입을 누르면 /chaos 화면이 열린다", async () => {
    renderApp("/");
    fireEvent.click(await screen.findByRole("link", { name: "장애 주입" }));
    expect(await screen.findByRole("heading", { name: "장애 주입" })).toBeTruthy();
    expect(location()).toBe("/chaos");
  });

  it("프리셋이 실패 확률과 범위를 채우고, 직접 바꾸면 프리셋 선택이 풀린다", async () => {
    await openForm();
    expect(preset("복구 시연").getAttribute("aria-pressed")).toBe("true");
    expect(radio("주 모델만 (primary)").checked).toBe(true);

    fireEvent.click(preset("정책 시연"));
    expect(preset("정책 시연").getAttribute("aria-pressed")).toBe("true");
    expect(preset("복구 시연").getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByLabelText(/^실패 확률/) as HTMLInputElement).value).toBe("0.8");
    expect(radio("대체 모델까지 (all)").checked).toBe(true);

    fireEvent.change(screen.getByLabelText(/^seed/), { target: { value: "42" } });
    expect(preset("정책 시연").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("(적용 중)")).toBeTruthy();

    fireEvent.click(preset("복구 시연"));
    expect(radio("주 모델만 (primary)").checked).toBe(true);
    expect((screen.getByLabelText(/^seed/) as HTMLInputElement).value).toBe("");
  });

  it("실행 → 비용 확인 → 신청 본문(직접 설정)을 보내고 만든 리포트 상세로 간다", async () => {
    const bodies = captureRuns();
    await openForm();
    fireEvent.change(screen.getByLabelText("종목 코드 (6자리)"), { target: { value: "005930" } });
    fireEvent.click(screen.getByLabelText("잘못된 출력 (bad_output)")); // 끄기
    fireEvent.click(screen.getByLabelText(/^뉴스·심리 Agent/));
    fireEvent.change(screen.getByLabelText(/^seed/), { target: { value: "42" } });

    fireEvent.click(runButton());
    const confirm = await screen.findByRole("group", { name: "실행 확인" });
    expect(confirm.textContent).toContain("비용이 들고");
    expect(confirm.textContent).toContain("팀 AI 하루 예산");
    expect(bodies).toEqual([]); // 확인 전에는 보내지 않는다

    fireEvent.click(within(confirm).getByRole("button", { name: "확인하고 실행" }));
    await waitFor(() => expect(location()).toBe("/reports/109"));
    expect(bodies).toEqual([
      {
        symbol: "005930",
        chaos: { enabled: true, probability: 0.8, scope: "primary", errorTypes: ["timeout", "server_error"], workers: ["news_agent"], seed: 42 },
      },
    ]);
    expect(await screen.findByRole("heading", { name: "리포트 #109" })).toBeTruthy();
    expect(screen.getByText(/seed 42 · 신청 admin/)).toBeTruthy();
  });

  it("프리셋 그대로면 확률·범위만 보내고 대상은 null(전부)이다", async () => {
    const bodies = captureRuns();
    await openForm();
    fireEvent.click(preset("정책 시연"));
    fireEvent.change(screen.getByLabelText("종목 코드 (6자리)"), { target: { value: "000660" } });
    fireEvent.click(runButton());
    fireEvent.click(await screen.findByRole("button", { name: "확인하고 실행" }));
    await waitFor(() => expect(bodies.length).toBe(1));
    expect(bodies[0]).toEqual({ symbol: "000660", chaos: { enabled: true, probability: 0.8, scope: "all", workers: null } });
  });

  it("종목 코드가 6자리가 아니거나 seed가 범위 밖이면 확인 단계로 가지 않는다", async () => {
    await openForm();
    fireEvent.change(screen.getByLabelText("종목 코드 (6자리)"), { target: { value: "5930" } });
    fireEvent.click(runButton());
    expect((await screen.findByRole("alert")).textContent).toBe("종목 코드는 숫자 6자리입니다 (예: 005930)");
    expect(screen.queryByRole("group", { name: "실행 확인" })).toBeNull();
    fireEvent.change(screen.getByLabelText("종목 코드 (6자리)"), { target: { value: "005930" } });
    fireEvent.change(screen.getByLabelText(/^seed/), { target: { value: "9007199254740992" } }); // 2^53
    fireEvent.click(runButton());
    expect(screen.getByRole("alert").textContent).toBe("seed는 0 이상 2^53 미만의 정수입니다 (비우면 서비스가 정한다)");
    expect(screen.queryByRole("group", { name: "실행 확인" })).toBeNull();
  });

  it.each([
    [409, { detail: "진행 중인 장애 주입 실행이 있어요. 끝난 뒤에 다시 신청해 주세요.", id: 76 }],
    [429, { detail: "오늘 팀 AI 예산을 다 썼어요." }],
    [400, { detail: "없는 종목입니다: 999999" }],
    [403, { detail: "관리자만 장애 주입을 신청할 수 있어요." }],
    [503, { detail: "서비스에 연결할 수 없습니다" }],
  ])("서비스의 %i 사유(detail)를 그대로 보여 준다", async (status, body) => {
    server.use(http.post("/api/admin/chaos/runs", () => HttpResponse.json(body, { status })));
    await openForm();
    fireEvent.change(screen.getByLabelText("종목 코드 (6자리)"), { target: { value: "005930" } });
    fireEvent.click(runButton());
    fireEvent.click(await screen.findByRole("button", { name: "확인하고 실행" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(body.detail);
    if (status === 409) expect(within(alert).getByRole("link", { name: "진행 중인 실행 #76 보기" }).getAttribute("href")).toBe("/reports/76");
    // 서비스(터널)에 닿지 못한 503은 "서비스 DB 연결 안 됨" 띠가 아니다
    expect(screen.queryByText("서비스 DB에 연결할 수 없습니다")).toBeNull();
    expect(location()).toBe("/chaos");
  });

  it("관리 서버에 비밀 값이 없으면(404) 꺼짐 안내를 보이고 폼을 막는다", async () => {
    server.use(
      http.get("/api/admin/chaos/options", () =>
        HttpResponse.json({ detail: "장애 주입이 꺼져 있습니다 (ADMIN_CHAOS_SECRET 없음)" }, { status: 404 }),
      ),
    );
    renderApp("/chaos");
    expect((await screen.findByRole("status")).textContent).toContain("장애 주입이 꺼져 있습니다 (ADMIN_CHAOS_SECRET 없음)");
    expect((runButton().closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("아래에 최근 장애 주입 실행(kind=chaos, 90일, 10건)을 리포트 상세 링크로 보여 준다", async () => {
    const urls: string[] = [];
    server.events.on("request:start", ({ request }) => {
      urls.push(request.url);
    });
    try {
      renderApp("/chaos");
      expect((await screen.findByRole("link", { name: "#108" })).getAttribute("href")).toBe("/reports/108");
      expect(screen.getByRole("link", { name: "#102" })).toBeTruthy();
      expect(screen.queryByRole("link", { name: "#107" })).toBeNull(); // 장애 주입이 아닌 실패
      const recent = new URL(urls.find((u) => u.includes("/api/admin/reports?"))!);
      expect([recent.searchParams.get("kind"), recent.searchParams.get("days"), recent.searchParams.get("limit")]).toEqual(["chaos", "90", "10"]);
    } finally {
      server.events.removeAllListeners();
    }
  });
});

describe("리포트 상세의 장애 주입 (F11)", () => {
  it("같은 설정으로 다시: 저장된 설정에서 requestedBy만 빼고(seed 포함) 같은 종목으로 신청한다", async () => {
    const bodies = captureRuns();
    renderApp("/reports/108");
    expect(await screen.findByText(/seed 4242 · 신청 admin/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "같은 설정으로 다시" }));
    fireEvent.click(within(await screen.findByRole("group", { name: "실행 확인" })).getByRole("button", { name: "확인하고 실행" }));
    await waitFor(() => expect(location()).toBe("/reports/109"));
    expect(bodies).toEqual([
      {
        symbol: "005930",
        chaos: { enabled: true, probability: 0.8, errorTypes: ["timeout", "server_error", "bad_output"], workers: null, scope: "primary", seed: 4242 },
      },
    ]);
  });

  it("장애 주입이 아닌 리포트에는 다시 버튼이 없다", async () => {
    renderApp("/reports/107");
    await screen.findByRole("heading", { name: "실행 기록 (시간순)" });
    expect(screen.queryByRole("button", { name: "같은 설정으로 다시" })).toBeNull();
  });

  it("대기·실행 중이면 3초마다 다시 받고, 끝나면 60초 간격으로 돌아간다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let status: "running" | "completed" = "running";
      let calls = 0;
      server.use(
        http.get("/api/admin/reports/:id/trace", () => {
          calls += 1;
          const t = trace(104)!;
          return HttpResponse.json({ ...t, report: { ...t.report, status } });
        }),
      );
      renderApp("/reports/104");
      expect(await screen.findByText("진행 중 · 3초마다 새로 고침")).toBeTruthy();
      expect(calls).toBe(1);
      await act(() => vi.advanceTimersByTimeAsync(3_000));
      await waitFor(() => expect(calls).toBe(2));

      status = "completed";
      await act(() => vi.advanceTimersByTimeAsync(3_000));
      await waitFor(() => expect(calls).toBe(3));
      await waitFor(() => expect(screen.queryByText("진행 중 · 3초마다 새로 고침")).toBeNull());
      await act(() => vi.advanceTimersByTimeAsync(9_000));
      expect(calls).toBe(3); // 끝났으니 3초마다 부르지 않는다 (간격이 바뀌어도 바로 다시 부르지도 않는다)
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      await waitFor(() => expect(calls).toBe(4));
    } finally {
      vi.useRealTimers();
    }
  });
});
