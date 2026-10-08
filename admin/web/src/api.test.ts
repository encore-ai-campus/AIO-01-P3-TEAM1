import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { apiState, getJson } from "./api";
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
