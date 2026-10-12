import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { resetApiStateForTests } from "./api";
import { resetMockTokens } from "./mocks/data";
import { setLoggedIn } from "./mocks/handlers";
import { server } from "./mocks/server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  setLoggedIn(false);
  resetMockTokens();
  resetApiStateForTests();
});
afterAll(() => server.close());
