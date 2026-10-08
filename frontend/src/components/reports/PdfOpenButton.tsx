import { useState } from "react";
import { ApiError, errorMessage } from "../../api/client";
import { cn } from "../../lib/cn";
import { ErrorPanel } from "../errors/ErrorPanel";
import { Icon } from "../Icon";
import { Spinner } from "../ui";

/**
 * 누른 순간(사용자 동작 안)에 빈 탭을 먼저 연다. PDF를 받은 뒤에 열면 Safari 등은 팝업으로 막는다.
 * noopener를 주면 window.open이 늘 null을 돌려줘 탭을 다룰 수 없으므로, 열고 나서 opener만 끊는다.
 */
function openPendingTab(): Window | null {
  const tab = window.open("", "_blank");
  if (!tab) return null;
  try {
    tab.document.title = "PDF 준비 중";
    tab.document.body.textContent = "PDF를 준비하고 있어요…";
    tab.opener = null;
  } catch {
    // 빈 탭 문서를 건드리지 못하는 브라우저는 빈 탭 그대로 둔다
  }
  return tab;
}

/** PDF를 실제로 받은 뒤 새 탭에서 연다. 준비 중·실패 상태를 현재 화면에 남긴다. */
export function PdfOpenButton({ reportId, view, className }: { reportId: number; view: "easy" | "expert"; className?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [blocked, setBlocked] = useState(false);
  const path = `/api/reports/${reportId}/pdf?view=${view}`;

  const open = async () => {
    if (loading) return;
    const tab = openPendingTab();
    setLoading(true);
    setError(null);
    setBlocked(false);
    try {
      const response = await fetch(new URL(path, window.location.origin), {
        credentials: "same-origin",
        // 오류 본문은 JSON이다. application/json이 빠지면 서버(DRF, JSON 렌더러만)가 완성된 리포트에도 406을 준다
        headers: { Accept: "application/pdf, text/html, application/json" },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        const detail = typeof body?.detail === "string" ? body.detail : `PDF 요청에 실패했습니다 (${response.status}).`;
        throw new ApiError(response.status, detail);
      }

      if (!tab) {
        // 팝업이 막혔다 — PDF는 준비됐으니 사용자가 직접 누르는 링크를 보여 준다 (서버가 만든 파일을 다시 쓴다)
        setBlocked(true);
        return;
      }
      if (tab.closed) return; // 기다리는 동안 사용자가 탭을 닫았다
      const objectUrl = URL.createObjectURL(await response.blob());
      tab.location.replace(objectUrl);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (caught) {
      tab?.close();
      setError(caught instanceof ApiError ? caught : new ApiError(0, "서버에 연결할 수 없습니다."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={cn("space-y-2", className)}>
      <button
        type="button"
        onClick={() => void open()}
        disabled={loading}
        aria-busy={loading || undefined}
        className="press flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-fill px-3 text-[15px] font-semibold text-ink hover:bg-line disabled:cursor-wait disabled:opacity-70"
      >
        {loading ? <Spinner /> : <Icon name="doc" className="size-4" />}
        {loading ? "PDF 준비 중" : "PDF로 보기"}
      </button>
      {blocked && (
        <p className="text-center text-[13px] leading-snug text-sub">
          새 창이 막혀 PDF를 띄우지 못했어요.{" "}
          <a href={path} target="_blank" rel="noreferrer" className="font-semibold text-brand-ink underline">
            여기를 눌러 PDF 열기
          </a>
        </p>
      )}
      {error !== null && (
        <ErrorPanel
          kind={error instanceof ApiError && error.status === 0 ? "network" : "pdf"}
          detail={errorMessage(error)}
          onRetry={() => void open()}
          retrying={loading}
          secondary={null}
          compact
        />
      )}
    </div>
  );
}
