// 목록 쪽 넘기기 (리포트 탭의 리포트 목록·교차검증 분석, 10개씩 — docs/DECISIONS.md 34장).
// sm 이상은 [이전 | 1 … 4 5 6 … 12 | 다음] (숫자는 7칸을 넘지 않는다), 모바일은 숫자 칸이 넘치지 않게 [이전 | 3 / 12 | 다음].
// 지금 쪽은 aria-current="page". 처음·끝에서 이전·다음은 aria-disabled로만 막는다 — disabled로 바꾸면 누른 버튼의 포커스가 사라진다.
// 버튼 이름에 목록 이름을 붙인다 ("리포트 목록 2페이지") — 한 화면에 쪽 넘기기가 둘이라 버튼만 훑어도 어느 목록인지 알게.
// 쪽을 넘겼는데 목록 머리가 화면 위로 지나가 있으면 목록 카드(anchorId 제목이 든 section)의 위로 옮긴다 (새 쪽을 첫 줄부터 읽게).
import { cn } from "../../lib/cn";
import { prefersReducedMotion } from "../../lib/motion";
import { Icon } from "../Icon";

/** 보일 쪽 번호 (1부터): 처음·끝·지금 ±1, 사이가 두 쪽 이상 비면 null(…). 한 쪽만 비면 그 번호를 그대로 둔다. */
function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const lo = Math.max(2, Math.min(current - 1, total - 4));
  const hi = Math.min(total - 1, Math.max(current + 1, 5));
  const out: (number | null)[] = [1];
  if (lo > 2) out.push(lo === 3 ? 2 : null);
  for (let p = lo; p <= hi; p++) out.push(p);
  if (hi < total - 1) out.push(hi === total - 2 ? total - 1 : null);
  out.push(total);
  return out;
}

const btn = "press relative grid h-10 min-w-10 place-items-center rounded-lg px-2 text-[14px] font-semibold tabular-nums";

export function Pager({
  page,
  total,
  onChange,
  name,
  anchorId,
  className,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
  /** 목록 이름 ("리포트 목록") — 묶음은 "○ 페이지", 버튼은 "○ 이전 페이지"·"○ 2페이지". */
  name: string;
  /** 쪽을 넘긴 뒤 보일 목록 카드의 제목 id (그 제목이 든 section의 scroll-margin을 따른다). */
  anchorId?: string;
  className?: string;
}) {
  if (total <= 1) return null;
  const go = (p: number) => {
    if (p < 1 || p > total || p === page) return;
    onChange(p);
    const card = anchorId ? document.getElementById(anchorId)?.closest("section") : null;
    if (card && card.getBoundingClientRect().top < 0 && typeof card.scrollIntoView === "function") {
      requestAnimationFrame(() => card.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" }));
    }
  };
  const step = (to: number, name: string, back: boolean) => {
    const off = to < 1 || to > total;
    return (
      <button
        type="button"
        aria-label={name}
        aria-disabled={off || undefined}
        onClick={() => go(to)}
        className={cn(btn, "text-sub", off ? "cursor-not-allowed opacity-40" : "hover:bg-fill")}
      >
        <Icon name="chevron" className={cn("size-4", back && "rotate-180")} />
      </button>
    );
  };
  return (
    <nav aria-label={`${name} 페이지`} className={cn("flex items-center justify-center gap-1 px-5 pt-3 pb-1", className)}>
      {step(page - 1, `${name} 이전 페이지`, true)}
      <p className="min-w-16 text-center text-[14px] text-sub tabular-nums sm:hidden">
        <b className="font-semibold text-ink">{page}</b> / {total}
      </p>
      <ol className="hidden items-center gap-1 sm:flex">
        {pageWindow(page, total).map((p, i) =>
          p === null ? (
            <li key={`gap-${i}`} aria-hidden="true" className="grid h-10 w-6 place-items-center text-[14px] text-mute">
              …
            </li>
          ) : (
            <li key={p}>
              <button
                type="button"
                aria-label={`${name} ${p}페이지`}
                aria-current={p === page ? "page" : undefined}
                onClick={() => go(p)}
                className={cn(btn, p === page ? "bg-ink text-on-ink" : "text-sub hover:bg-fill")}
              >
                {p}
              </button>
            </li>
          ),
        )}
      </ol>
      {step(page + 1, `${name} 다음 페이지`, false)}
    </nav>
  );
}
