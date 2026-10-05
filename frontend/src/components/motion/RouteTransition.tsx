// 화면이 바뀔 때 opacity만 160ms 페이드한다 (Layout의 Outlet을 감싼다).
// transform·filter는 쓰지 않는다: 이 래퍼 안의 fixed 요소(구매 바·시트)가 화면이 아니라 래퍼를 기준으로 붙어 화면 밖으로 나간다.
// 뒤로·앞으로·첫 로드(POP)는 바로 보인다 (iOS 스와이프 뒤로의 자체 애니메이션과 겹치지 않고, 스크롤 복원이 바로 보이게).
import { type ReactNode, useState } from "react";
import { useLocation, useNavigationType } from "react-router";

function Page({ animate, children }: { animate: boolean; children: ReactNode }) {
  // 마운트할 때 한 번만 정한다 (뒤에 쿼리만 바뀌어도 다시 재생되지 않게). fill backwards라 끝나면 쌓임 맥락도 사라진다
  const [className] = useState(animate ? "animate-page-in" : undefined);
  return <div className={className}>{children}</div>;
}

/** key = 주소 + ?view 값. 같은 주소에서 쿼리(?tab= 등)만 바뀌면 다시 그리지 않는다. */
export function RouteTransition({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  const navType = useNavigationType();
  const view = new URLSearchParams(search).get("view") ?? "";
  return (
    <Page key={`${pathname}|${view}`} animate={navType !== "POP"}>
      {children}
    </Page>
  );
}
