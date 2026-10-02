import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("빈 main 요소를 렌더한다", () => {
    render(<App />);
    expect(screen.getByRole("main")).toBeTruthy();
  });
});
