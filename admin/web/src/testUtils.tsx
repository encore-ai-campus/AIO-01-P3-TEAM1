import { render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import App from "./App";
import { AuthProvider } from "./auth";
import { setLoggedIn } from "./mocks/handlers";

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="location">{l.pathname + l.search}</div>;
}

/** 앱 전체를 주어진 경로에서 그린다. loggedIn이면 가짜 API의 세션을 미리 연다. */
export function renderApp(path = "/", { loggedIn = true }: { loggedIn?: boolean } = {}) {
  setLoggedIn(loggedIn);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  );
}
