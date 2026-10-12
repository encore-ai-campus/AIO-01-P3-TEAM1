// 앱 인트로 (5초 + 끝 0.5초): 앱을 열 때(주소가 / 또는 /login인 새로 열기·새로고침) 로그인 화면 앞에서 BrandIntro를 화면 위에 덮는다. 눌러도 끝난다.
// 앱 안에서 화면을 옮길 때는 다시 나오지 않는다. 주소 끝에 ?intro=1을 붙이면 어느 화면에서든 보여 준다.
// 보이지 않는 경우: 움직임 줄이기 설정, 디자인 검수 화면(/ui/*), 다른 화면으로 바로 연 주소(예: 알림 링크), 테스트.
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { BrandIntro } from "./BrandIntro";

const INTRO_MS = 5000;

function shouldPlay(pathname: string, search: string): boolean {
  if (import.meta.env.MODE === "test") return false;
  if (pathname.startsWith("/ui/")) return false;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
  if (new URLSearchParams(search).get("intro") === "1") return true;
  return pathname === "/" || pathname === "/login";
}

export function IntroGate() {
  const { pathname, search } = useLocation();
  // 처음 그릴 때의 주소로만 정한다 — 로그인 뒤 화면이 바뀌어도 다시 나오지 않는다
  const [show, setShow] = useState(() => shouldPlay(pathname, search));

  // 인트로가 도는 동안은 아래 화면의 로고 반복 모션(.brand-hop)을 멈춰 두었다가, 끝나면 그때부터 시작한다 (index.css)
  useEffect(() => {
    if (!show) return;
    const root = document.documentElement;
    root.dataset.intro = "playing";
    return () => {
      delete root.dataset.intro;
    };
  }, [show]);

  if (!show) return null;
  return <BrandIntro overlay lockup durationMs={INTRO_MS} onDone={() => setShow(false)} />;
}
