import { useState } from "react";
import { ApiError, errorMessage } from "../../api/client";
import { cn } from "../../lib/cn";
import { ErrorPanel } from "../errors/ErrorPanel";
import { Icon } from "../Icon";
import { Spinner } from "../ui";

/** PDF를 실제로 받은 뒤 새 탭에서 연다. 준비 중·실패 상태를 현재 화면에 남긴다. */
export function PdfOpenButton({ reportId, view, className }: { reportId: number; view: "easy" | "expert"; className?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const open = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const url = new URL(`/api/reports/${reportId}/pdf`, window.location.origin);
      url.searchParams.set("view", view);
      const response = await fetch(url, {
        credentials: "same-origin",
        headers: { Accept: "application/pdf, text/html" },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        const detail = typeof body?.detail === "string" ? body.detail : `PDF 요청에 실패했습니다 (${response.status}).`;
        throw new ApiError(response.status, detail);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const tab = window.open(objectUrl, "_blank", "noopener,noreferrer");
      if (!tab) {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (caught) {
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
