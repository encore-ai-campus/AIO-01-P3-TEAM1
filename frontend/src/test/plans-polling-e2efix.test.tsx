// OPS-8: usePlans — 진행 중 계획이 있을 때만 5초, 없으면 30초 (docs/API.md 프론트 폴링).
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Providers } from "../App";
import { POLL, keys, usePlans } from "../api/queries";
import { createQueryClient } from "../lib/queryClient";
import * as db from "../mocks/db";
import { server } from "../mocks/server";

function plansWith(statuses: string[]) {
  server.use(
    http.get("*/api/trade-plans", () =>
      HttpResponse.json({ count: statuses.length, results: statuses.map((status, i) => ({ id: i + 1, status })) }),
    ),
  );
}

async function pollingOf(status: "active" | "all") {
  db.setSession("alice");
  const client = createQueryClient({ retry: false });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <Providers client={client}>{children}</Providers>
    </MemoryRouter>
  );
  const { result } = renderHook(() => usePlans(status), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const options = client.getQueryCache().find({ queryKey: keys.plans(status) })!.observers[0].options;
  const interval = typeof options.refetchInterval === "function" ? options.refetchInterval(client.getQueryCache().find({ queryKey: keys.plans(status) })!) : options.refetchInterval;
  return [interval, options.refetchIntervalInBackground];
}

describe("usePlans 폴링", () => {
  it("간격 상수: 진행 중 5초, 없으면 30초", () => {
    expect([POLL.plan, POLL.planIdle]).toEqual([5000, 30_000]);
  });

  it("진행 중 계획(active·entry_pending·holding)이 하나라도 있으면 5초, 탭이 가려지면 멈춘다", async () => {
    for (const live of ["active", "entry_pending", "holding"]) {
      plansWith(["closed", live]);
      expect(await pollingOf("all")).toEqual([5000, false]);
    }
  });

  it("진행 중 계획이 없으면(비었거나 모두 끝남) 30초", async () => {
    plansWith([]);
    expect(await pollingOf("active")).toEqual([30_000, false]);
    plansWith(["closed", "cancelled", "expired", "failed"]);
    expect(await pollingOf("all")).toEqual([30_000, false]);
  });
});
