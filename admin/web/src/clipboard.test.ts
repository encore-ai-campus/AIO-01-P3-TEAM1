import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("클립보드 복사", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(document, "execCommand");
  });

  it("navigator.clipboard가 있으면 그것을 쓴다", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(await copyText("abc")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
  });

  it("HTTP라 clipboard가 없거나 막히면 숨긴 textarea로 복사하고, 치운 뒤 포커스를 돌려준다", async () => {
    const button = document.body.appendChild(document.createElement("button"));
    button.focus();
    let copied = "";
    const execCommand = vi.fn(() => {
      copied = (document.activeElement as HTMLTextAreaElement).value ?? "";
      return true;
    });
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    expect(await copyText("token-1")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copied).toBe("token-1");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it("둘 다 안 되면 false", async () => {
    expect(await copyText("x")).toBe(false);
  });
});
