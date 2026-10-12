// 클립보드 복사. 관리 서버는 HTTP(보안 컨텍스트가 아님)로 열려 있어 navigator.clipboard가 없을 수 있다 —
// 그때는 숨긴 textarea를 골라 execCommand("copy")로 한 번 더 시도한다.

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 권한이 없으면 아래 방법으로 */
    }
  }
  const before = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  try {
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    before?.focus();
  }
}
