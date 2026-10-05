// Markdown 렌더 (리포트 본문, 교육용 문서). HTML 태그는 그리지 않는다 (react-markdown 기본값).
// 제목은 levelOffset만큼 낮춘다 (기본 1: 화면 제목이 h1이다). 카드 제목(h2) 아래에 놓이면 2를 준다 —
// 눈으로 읽는 위계(카드 제목 > 문서 제목)와 화면 읽기 프로그램의 제목 순서가 같게. 글자 크기도 제목 단계를 따른다.
// 코드 블록은 라이트에서 반전(진한 바탕), 다크에서는 반전하면 눈부신 큰 흰 상자가 되므로 카드보다 어두운 우물로 둔다.
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type Level = 2 | 3 | 4 | 5 | 6;

// 문서의 제목 단계(# ~ ####)별 모양. 화면 h1 아래(기본)와 카드 제목 아래(카드 안 — 한 단계씩 작게, 문서 제목이 카드 제목보다 크지 않게)
const SIZE: Record<"page" | "card", [string, string, string, string]> = {
  page: [
    "mt-2 mb-3 text-[22px] font-bold tracking-tight lg:text-[26px]",
    "mt-7 mb-2 border-b border-line pb-1.5 text-[18px] font-bold",
    "mt-5 mb-2 text-[16px] font-bold",
    "mt-4 mb-1.5 text-[15px] font-bold",
  ],
  card: [
    "mb-2 text-[17px] font-bold tracking-tight",
    "mt-6 mb-2 border-b border-line pb-1.5 text-[16px] font-bold",
    "mt-4 mb-1.5 text-[15px] font-bold",
    "mt-3 mb-1 text-[14px] font-bold text-sub",
  ],
};

function components(offset: 1 | 2): Components {
  const look = SIZE[offset === 2 ? "card" : "page"];
  const heading = (depth: 1 | 2 | 3 | 4) =>
    function Heading({ children }: { children?: ReactNode }) {
      const Tag = `h${Math.min(6, depth + offset) as Level}` as const;
      return <Tag className={look[depth - 1]}>{children}</Tag>;
    };
  return {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    p: ({ children }) => <p className="my-2.5 text-[15px] leading-relaxed">{children}</p>,
    ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-5 text-[15px] leading-relaxed">{children}</ul>,
    ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1 pl-5 text-[15px] leading-relaxed">{children}</ol>,
    a: ({ children, href }) => (
      <a href={href} className="font-semibold text-brand-ink underline" target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
    blockquote: ({ children }) => <blockquote className="my-3 border-l-4 border-line pl-3 text-sub">{children}</blockquote>,
    code: ({ children }) => <code className="rounded bg-fill px-1 py-0.5 font-mono text-[0.88em]">{children}</code>,
    pre: ({ children }) => (
      <pre className="my-3 overflow-x-auto rounded-xl bg-ink p-3.5 font-mono text-[13px] leading-relaxed text-on-ink dark:bg-bg dark:text-ink dark:ring-1 dark:ring-line [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[13px]">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-left text-[14px]">{children}</table>
      </div>
    ),
    th: ({ children, style }) => (
      <th style={style} className="border-b-2 border-line bg-fill px-2.5 py-2 font-semibold whitespace-nowrap">
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td style={style} className="border-b border-line px-2.5 py-2 align-top">
        {children}
      </td>
    ),
    hr: () => <hr className="my-5 border-line" />,
  };
}

const DEFAULT = components(1);
const IN_CARD = components(2);

/** levelOffset: 1(기본, 화면 h1 아래) · 2(카드 제목 h2 아래 — 문서 맨 위 h1이 h3이 된다). */
export function Markdown({ children, levelOffset = 1 }: { children: string; levelOffset?: 1 | 2 }) {
  return (
    <div className="min-w-0 text-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={levelOffset === 2 ? IN_CARD : DEFAULT}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
