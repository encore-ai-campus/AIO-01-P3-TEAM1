// 브라우저 탭 제목 = "<화면 이름> · 모매매"(SERVICE_NAME). 탭·방문 기록에서 화면을 구분하고, 화면 읽기 프로그램이 새 화면을 알게 한다.
import { useEffect } from "react";
import { SERVICE_NAME } from "../lib/plainText";

/** name이 있는 동안 제목을 바꾸고, 화면이 사라지면 서비스 이름으로 되돌린다 (다음 화면이 같은 커밋에서 다시 정한다). */
export function useDocumentTitle(name: string | null | undefined) {
  useEffect(() => {
    if (!name) return;
    document.title = `${name} · ${SERVICE_NAME}`;
    return () => {
      document.title = SERVICE_NAME;
    };
  }, [name]);
}
