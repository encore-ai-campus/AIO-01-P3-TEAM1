import { useState } from "react";
import { ErrorPanel } from "../components/errors/ErrorPanel";
import type { ErrorKind } from "../components/errors/errorTypes";
import { Card, PageHeader, Segmented } from "../components/ui";

const OPTIONS: { value: ErrorKind; label: string }[] = [
  { value: "network", label: "연결" },
  { value: "validation", label: "입력" },
  { value: "rate_limit", label: "한도" },
  { value: "unavailable", label: "서비스" },
  { value: "workflow", label: "Workflow" },
  { value: "pdf", label: "PDF" },
];

/** VITE_MOCK=1에서만 라우트가 열리는 디자인 검수용 화면. 실제 API나 비용이 드는 요청은 보내지 않는다. */
export function ErrorPreviewPage() {
  const [kind, setKind] = useState<ErrorKind>("network");
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    window.setTimeout(() => setRetrying(false), 700);
  };

  return (
    <>
      <PageHeader title="에러 화면 미리보기" back />
      <div className="space-y-3">
        <Card>
          <p className="text-[14px] leading-relaxed text-sub">
            백엔드 없이 오류 화면의 문구·버튼·모바일 배치를 확인하는 디자인 검수용 화면입니다.
          </p>
          <div className="mt-4 overflow-x-auto pb-1">
            <Segmented value={kind} options={OPTIONS} onChange={setKind} label="오류 종류" surface="page" />
          </div>
        </Card>
        <ErrorPanel kind={kind} onRetry={retry} retrying={retrying} />
      </div>
    </>
  );
}
