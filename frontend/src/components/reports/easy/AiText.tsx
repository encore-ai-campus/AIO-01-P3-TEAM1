// 쉬운 보기 리포트의 AI 글 한 덩이: 전문 용어에 용어 풀이(Term)를 붙여 그린다 (UX-4 화면 쪽).
// 어느 용어를 어느 글에 붙일지는 화면 순서대로 한 번에 정한다(AiTermsProvider — 용어마다 처음 나온 한 번만, lib/reportTerms.ts linkTerms).
// 공급자 밖이거나 등록하지 않은 글은 그대로 그린다 (전문가 보기·다른 화면).
import { type ReactNode, createContext, useContext } from "react";
import { type TermSegment, linkTerms } from "../../../lib/reportTerms";
import { Term } from "../../Term";

const TermsContext = createContext<ReadonlyMap<string, TermSegment[]> | null>(null);

/** texts: 이 화면의 AI 글을 화면에 나오는 순서대로 (비어 있거나 같은 글은 건너뛴다). 글 열 몇 개라 렌더마다 다시 정해도 가볍다. */
export function AiTermsProvider({ texts, children }: { texts: readonly (string | null | undefined)[]; children: ReactNode }) {
  return <TermsContext.Provider value={linkTerms(texts)}>{children}</TermsContext.Provider>;
}

export function AiText({ text }: { text: string }) {
  const map = useContext(TermsContext);
  const segments = map?.get(text);
  if (!segments) return <>{text}</>;
  return (
    <>
      {segments.map((s, i) =>
        typeof s === "string" ? (
          s
        ) : (
          <Term key={`${s.key}-${i}`} k={s.key}>
            {s.text}
          </Term>
        ),
      )}
    </>
  );
}
