// 한 화면의 렌더 오류가 앱 전체를 흰 화면으로 만들지 않게 막는다. 다른 화면으로 가면(pathname이 바뀌면) 새로 시작한다.
import { Component, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Icon } from "../Icon";

function Fallback({ onRetry }: { onRetry: () => void }) {
  return (
    <section role="alert" aria-labelledby="route-error-title" className="mt-4 flex flex-col items-center gap-3 rounded-2xl bg-card px-5 py-12 text-center lg:mt-0">
      <Icon name="alert" className="size-8 text-warn" />
      <h2 id="route-error-title" className="text-[18px] font-bold text-ink">
        화면을 그리다 문제가 생겼어요
      </h2>
      <p className="text-[15px] text-sub">잠시 뒤 다시 시도해 주세요. 계속되면 홈에서 다시 들어와 주세요.</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onRetry} className="press h-11 rounded-xl bg-brand px-5 text-[15px] font-semibold text-white hover:bg-brand-dark">
          다시 시도
        </button>
        <Link to="/" className="press grid h-11 place-items-center rounded-xl bg-fill px-5 text-[15px] font-semibold text-sub hover:bg-line">
          홈으로
        </Link>
      </div>
    </section>
  );
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true }; // 오류 내용은 React가 콘솔에 남긴다
  }

  render() {
    if (this.state.failed) return <Fallback onRetry={() => this.setState({ failed: false })} />;
    return this.props.children;
  }
}

export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Boundary key={pathname}>{children}</Boundary>;
}
