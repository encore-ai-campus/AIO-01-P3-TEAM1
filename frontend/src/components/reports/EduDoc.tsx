// 교육용 문서: 저장소의 docs/교육용문서.md를 복사하지 않고 그대로 읽어 렌더한다 (vite.config.ts의 server.fs.allow).
import doc from "../../../../docs/교육용문서.md?raw";
import { Markdown } from "./Markdown";

export function EduDoc() {
  return (
    <article aria-label="교육용 문서">
      <Markdown>{doc}</Markdown>
    </article>
  );
}
