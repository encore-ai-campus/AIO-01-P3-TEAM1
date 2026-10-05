// 리포트·교차검증 분석 목록의 스켈레톤: 카드 모양(이름·배지 줄·메타) 3행. 실제 카드와 높이가 비슷해 내용이 오면 출렁이지 않는다.
// aria-busy + '불러오는 중' 이름 (role=status는 토스트만 쓴다).
import { Skeleton } from "../ui";

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="group" aria-busy="true" aria-label="불러오는 중" className="mt-2 divide-y divide-line">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2 px-5 py-3.5">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
      ))}
    </div>
  );
}
