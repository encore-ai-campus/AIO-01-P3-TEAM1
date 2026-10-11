import { useRef, useState } from "react";
import { BrandIntro } from "../components/brand/BrandIntro";
import { BrandLockup, BrandMark, Wordmark } from "../components/brand/BrandMark";
import { Card, PageHeader } from "../components/ui";

const SIZES = [16, 24, 32, 48, 96];

/** VITE_MOCK=1 전용: 새 로고·워드마크·인트로를 로그인과 백엔드 없이 확인하고, 발표 영상용으로 화면 녹화한다. */
export function BrandPreviewPage() {
  const [run, setRun] = useState(0);
  const stage = useRef<HTMLDivElement>(null);

  return (
    <>
      <PageHeader title="로고·인트로 미리보기" back />
      <div className="space-y-3 lg:space-y-4">
        <Card aria-label="인트로 재생">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[15px] font-bold">인트로 (5초)</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setRun((n) => n + 1)} className="press h-11 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand hover:bg-brand-dark">
                다시 재생
              </button>
              <button
                type="button"
                onClick={() => void stage.current?.requestFullscreen?.()}
                className="press h-11 rounded-xl bg-fill px-4 text-[14px] font-semibold text-ink hover:bg-line"
              >
                전체 화면
              </button>
            </div>
          </div>
          {/* 전체 화면으로 녹화하면 배경이 화면을 채운다 */}
          <div ref={stage} className="mt-3 grid place-items-center rounded-2xl bg-card py-8 ring-1 ring-line">
            <div className="w-full max-w-[640px] px-4">
              <BrandIntro key={run} durationMs={5000} lockup />
            </div>
          </div>
          <p className="mt-2 text-[12px] leading-snug text-mute">
            앱을 열 때(주소가 / 또는 /login)마다 같은 5초 인트로가 로그인 화면 앞에 나오고(끝나고 0.5초 뒤 사라져요), 화면을 누르면 바로 끝나요. 어느 화면에서든 주소 끝에 ?intro=1을 붙이면 볼 수 있어요. 발표 영상은 이 화면을 녹화하세요.
          </p>
        </Card>

        <Card aria-label="로고 크기">
          <p className="text-[15px] font-bold">크기별 (실제 px)</p>
          <div className="mt-3 flex flex-wrap items-end gap-5">
            {SIZES.map((s) => (
              <figure key={s} className="flex flex-col items-center gap-1.5">
                <BrandMark size={s} label={`${s}px`} />
                <figcaption className="text-[12px] text-mute">{s}</figcaption>
              </figure>
            ))}
          </div>
          <div className="mt-5 space-y-3">
            <BrandLockup size={32} className="text-[19px] text-ink" />
            <BrandLockup size={28} className="text-[18px] text-ink" />
            <Wordmark height={56} className="text-ink" />
          </div>
        </Card>
      </div>
    </>
  );
}
