import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import App, { Providers } from "../App";
import { createQueryClient } from "../lib/queryClient";
import { setSession } from "../mocks/db";
// 시각 고정은 ./time.ts의 freezeTime (react-refresh 규칙 때문에 여기서 다시 내보내지 않는다)

/** 앱 전체를 path에서 그린다. user를 주면 그 계정으로 로그인한 상태에서 시작한다. */
export function renderApp(path: string, user: string | null = "alice") {
  setSession(user);
  const client = createQueryClient({ retry: false });
  return {
    client,
    ...render(
      <MemoryRouter initialEntries={[path]}>
        <Providers client={client}>
          <App />
        </Providers>
      </MemoryRouter>,
    ),
  };
}
