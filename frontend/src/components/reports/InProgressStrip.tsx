// 리포트 탭 맨 위의 "만드는 중인 내 리포트" 띠. 하단 탭 '리포트'의 점(●, 만드는 중인 내 리포트가 있다는 약속 — docs/plans/컨셉변경계획.md 4-6)을
// 보고 들어온 사람의 목적지를 첫 화면에 둔다 (다시 들어오는 이유는 대부분 "내 리포트 다 됐나"다). 없으면 그리지 않는다.
// 캐시는 하단 탭의 점·홈의 '만드는 중인 리포트'와 같다 (useReports({mine: true}) — 요청이 늘지 않는다). 2개까지 보이고 나머지는 내 리포트 목록으로.
// 늦게 받으면 툭 끼어들지 않게 펼친다 (캐시로 바로 그리면 처음부터 열려 있다). 아래 카드와의 간격도 펼쳐지는 안쪽에 둔다.
// 살아 있음 점(LiveDot)은 실제로 만드는 중인 리포트가 있을 때만 — 모두 대기 중이면 시계 아이콘 (점은 '진행 중'이라는 뜻이다).
import { useId } from "react";
import { Link, useSearchParams } from "react-router";
import { useReports } from "../../api/queries";
import type { ReportSummary } from "../../api/types";
import { formatRelative } from "../../lib/format";
import { prefersReducedMotion } from "../../lib/motion";
import { reportStatusText } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Collapse } from "../motion/Collapse";
import { LiveDot } from "../ui";

const SHOWN = 2;

function Row({ r, expert }: { r: ReportSummary; expert: boolean }) {
  const id = useId();
  return (
    <li>
      <Link
        to={`/reports/${r.id}`}
        aria-label={`${r.name} 리포트 진행 보기`}
        aria-describedby={id}
        className="press-row flex min-h-14 items-center gap-3 px-5 py-2.5 hover:bg-fill/60"
      >
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-ink">
          <Icon name="doc" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{r.name}</span>
          <span id={id} className="block text-[13px] text-mute">
            {reportStatusText(r.status, !expert)} · {formatRelative(r.createdAt)} 신청
          </span>
        </span>
        <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />
      </Link>
    </li>
  );
}

export function InProgressStrip({ expert }: { expert: boolean }) {
  const [, setParams] = useSearchParams();
  const { data } = useReports({ mine: true });
  const list = (data?.results ?? []).filter((r) => r.status === "requested" || r.status === "running");
  const running = list.some((r) => r.status === "running");
  const more = list.length - SHOWN;
  // '내 리포트 모두 보기': 같은 화면의 목록 묶음을 '내 리포트'로 바꾸고(다른 쿼리 — ?view 등 — 는 그대로) 목록으로 내려간다
  const showMine = () => {
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        sp.set("list", "mine");
        return sp;
      },
      { replace: true },
    );
    requestAnimationFrame(() => {
      const title = document.getElementById("list-title");
      if (title && typeof title.scrollIntoView === "function") title.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    });
  };
  return (
    // 부모의 space-y 간격은 나타나는 순간 툭 생기므로 끄고(mb-0), 같은 간격을 펼쳐지는 안쪽(pb)에 둔다
    <Collapse open={list.length > 0} className="mb-0">
      <div className="pb-3 lg:pb-4">
        <section aria-labelledby="making-title" className="rounded-2xl bg-card px-5 pt-3.5 pb-1.5">
          <h2 id="making-title" className="flex items-center gap-2 text-[15px] font-bold">
            {running ? <LiveDot /> : <Icon name="clock" className="size-4 shrink-0 text-mute-weak" />}
            만드는 중인 내 리포트
            <span className="font-semibold text-mute tabular-nums">{list.length}개</span>
          </h2>
          <ul aria-label="만드는 중인 내 리포트" className="-mx-5 mt-1.5 divide-y divide-line">
            {list.slice(0, SHOWN).map((r) => (
              <Row key={r.id} r={r} expert={expert} />
            ))}
          </ul>
          {more > 0 && (
            <button
              type="button"
              onClick={showMine}
              className="press -mx-1.5 mb-1.5 flex h-11 items-center gap-0.5 rounded-lg px-1.5 text-[14px] font-semibold text-brand-ink hover:bg-fill"
            >
              내 리포트 {list.length}개 모두 보기
              <Icon name="chevron" className="size-4" />
            </button>
          )}
        </section>
      </div>
    </Collapse>
  );
}
