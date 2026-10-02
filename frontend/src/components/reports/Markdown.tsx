// Markdown 렌더 (리포트 본문, 교육용 문서). HTML 태그는 그리지 않는다 (react-markdown 기본값).
// 제목은 한 단계씩 낮춘다 (화면 제목이 h1이다).
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const COMPONENTS: Components = {
  h1: ({ children }) => <h2 className="mt-2 mb-3 text-[22px] font-bold tracking-tight lg:text-[26px]">{children}</h2>,
  h2: ({ children }) => <h3 className="mt-7 mb-2 border-b border-line pb-1.5 text-[18px] font-bold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-5 mb-2 text-[16px] font-bold">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-4 mb-1.5 text-[15px] font-bold">{children}</h5>,
  p: ({ children }) => <p className="my-2.5 text-[15px] leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-5 text-[15px] leading-relaxed">{children}</ul>,
  ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1 pl-5 text-[15px] leading-relaxed">{children}</ol>,
  a: ({ children, href }) => (
    <a href={href} className="font-semibold text-brand underline" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  blockquote: ({ children }) => <blockquote className="my-3 border-l-4 border-line pl-3 text-sub">{children}</blockquote>,
  code: ({ children }) => <code className="rounded bg-fill px-1 py-0.5 font-mono text-[0.88em]">{children}</code>,
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-xl bg-ink p-3.5 font-mono text-[13px] leading-relaxed text-white [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[13px]">
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

export function Markdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 text-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
