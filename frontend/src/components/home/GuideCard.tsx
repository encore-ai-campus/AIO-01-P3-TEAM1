// 쉬운 보기 홈의 3단계 안내 (docs/컨셉변경계획.md 4-2): ① 리포트 만들기 → ② 검토 → ③ 모의 자동매매.
// 처음 방문(이 브라우저에서 아직 닫지 않음)이거나 내 리포트가 하나도 없으면 보인다.
// "닫았음"은 이 브라우저에만 남기는 편의 값이다 (저장이 안 되면 다음에 다시 보일 뿐).
import { useState } from "react";
import { Link } from "react-router";
import { Icon } from "../Icon";
import { Card } from "../ui";

const STORAGE_KEY = "home-guide-closed";

const keyOf = (userId: number) => `${STORAGE_KEY}:${userId}`;

function readGuideClosed(userId: number): boolean {
  try {
    return localStorage.getItem(keyOf(userId)) === "1";
  } catch {
    return false;
  }
}

function writeGuideClosed(userId: number) {
  try {
    localStorage.setItem(keyOf(userId), "1");
  } catch {
    // 저장할 수 없으면 이번 화면에서만 닫는다
  }
}

const STEPS = [
  { n: 1, title: "리포트 만들기", body: "종목을 고르고 \"AI 리포트 만들기\"를 눌러요. 닫아도 계속 만들어요." },
  { n: 2, title: "검토", body: "AI 의견·근거·위험과 손절에 팔면 잃는 금액을 읽어요." },
  { n: 3, title: "모의 자동매매", body: "확인을 마치면 모의 계좌에서 정해 둔 가격대로 사고팔아요." },
];

/**
 * 3단계 안내 카드. hasReports가 false(내 리포트 0개)면 늘 보이고 닫기 버튼이 없다.
 * 내 리포트가 있으면 처음 방문에만 보이고, 닫으면 이 브라우저에서는 다시 보이지 않는다.
 */
export function GuideCard({ userId, hasReports }: { userId: number; hasReports: boolean }) {
  const [closed, setClosed] = useState(() => readGuideClosed(userId));
  if (hasReports && closed) return null;
  return (
    <Card aria-labelledby="guide-title" className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="guide-title" className="text-[19px] font-bold">
            3단계로 연습해요
          </h2>
          <p className="mt-1 text-[14px] leading-snug text-sub">팀이 함께 쓰는 1,000만 원 모의 계좌로 연습해요 (되돌릴 수 없어요)</p>
        </div>
        {hasReports && (
          <button
            type="button"
            aria-label="안내 닫기"
            onClick={() => {
              writeGuideClosed(userId);
              setClosed(true);
            }}
            className="grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-fill"
          >
            <Icon name="close" className="size-5" />
          </button>
        )}
      </div>
      <ol aria-label="연습 순서" className="grid gap-2 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.n} className="flex gap-3 rounded-xl bg-fill p-3.5 sm:flex-col sm:gap-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand text-[14px] font-bold text-white" aria-hidden="true">
              {s.n}
            </span>
            <span className="min-w-0">
              <span className="block text-[15px] font-bold">
                <span className="sr-only">{`${s.n}단계: `}</span>
                {s.title}
                {i < STEPS.length - 1 && (
                  <span aria-hidden="true" className="ml-1 text-mute">
                    →
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-[13px] leading-snug text-sub">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <Link
        to="/search"
        className="flex h-12 items-center justify-center gap-1.5 rounded-xl bg-brand text-[15px] font-semibold text-white hover:bg-brand-dark"
      >
        <Icon name="search" className="size-5" />
        종목 고르기
      </Link>
    </Card>
  );
}
