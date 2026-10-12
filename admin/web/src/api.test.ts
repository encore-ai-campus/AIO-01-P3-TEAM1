import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ApiError, apiState, createChaosRun, getJson } from "./api";
import { setLoggedIn } from "./mocks/handlers";
import { server } from "./mocks/server";

describe("DB 연결 안내 띠", () => {
  it("DB를 쓰지 않는 경로의 성공으로는 꺼지지 않고, DB를 쓰는 경로가 성공해야 꺼진다", async () => {
    setLoggedIn(true);
    server.use(http.get("/api/admin/engine", () => HttpResponse.json({ detail: "서비스 DB에 연결할 수 없습니다" }, { status: 503 })));
    await expect(getJson("/api/admin/engine")).rejects.toThrow("서비스 DB에 연결할 수 없습니다");
    expect(apiState.dbDown()).toBe(true);
    await getJson("/api/admin/service");
    await getJson("/api/admin/overview");
    expect(apiState.dbDown()).toBe(true);
    await getJson("/api/admin/costs?days=7");
    expect(apiState.dbDown()).toBe(false);
  });
});

describe("장애 주입 경로의 503", () => {
  it("서비스(터널)에 닿지 못한 503은 DB 띠를 켜지 않고, DB 문구의 503만 켠다. 오류 본문은 ApiError.body로 넘긴다", async () => {
    setLoggedIn(true);
    server.use(http.post("/api/admin/chaos/runs", () => HttpResponse.json({ detail: "서비스에 연결할 수 없습니다" }, { status: 503 })));
    await expect(createChaosRun("005930", { enabled: true })).rejects.toThrow("서비스에 연결할 수 없습니다");
    expect(apiState.dbDown()).toBe(false);
    server.use(http.post("/api/admin/chaos/runs", () => HttpResponse.json({ detail: "서비스 DB에 연결할 수 없습니다" }, { status: 503 })));
    await expect(createChaosRun("005930", { enabled: true })).rejects.toThrow("서비스 DB에 연결할 수 없습니다");
    expect(apiState.dbDown()).toBe(true);
    server.use(http.post("/api/admin/chaos/runs", () => HttpResponse.json({ detail: "진행 중", id: 76 }, { status: 409 })));
    const err = await createChaosRun("005930", { enabled: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body).toEqual({ detail: "진행 중", id: 76 });
  });
});
