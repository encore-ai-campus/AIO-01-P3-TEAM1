// /ops: 관리자 화면 (숨은 화면). 하단 탭·왼쪽 메뉴의 "리포트"를 8번 연속 누르면 열린다 (src/lib/secretTaps.ts).
// 운영·발표용 화면을 모은다: 복구 지표(예전 /reports/health), 개념 문서(예전 /reports 전문가 보기). 관리자(staff) 계정만 본다.
// 순서: 안내 → 복구 지표(발표용 핵심 수치가 먼저) → 개념 문서(접힘, 구조 설명) → 다른 관리 도구(외부 링크는 마지막).
import { useMe } from "../api/queries";
import { RecoveryStatsPanel } from "../components/admin/RecoveryStatsPanel";
import { Icon } from "../components/Icon";
import { EduDocSection } from "../components/reports/EduDocSection";
import { Card, EmptyState, Notice, PageHeader } from "../components/ui";

export function AdminPage() {
  const { data: me } = useMe();

  if (!me?.isStaff) {
    return (
      <>
        <PageHeader title="관리자" back />
        <Card>
          <EmptyState>
            관리자 계정만 볼 수 있습니다. 관리자 지정은 Django 관리자 화면(사용자 → 스태프 권한)이나
            <code className="mx-1 rounded bg-fill px-1.5 py-0.5 text-[13px]">manage.py createsuperuser</code>로 합니다.
          </EmptyState>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="관리자" back />
      <div className="space-y-3 lg:space-y-4">
        <Notice>운영·발표용 화면입니다. 사용자 메뉴에는 보이지 않고, &ldquo;리포트&rdquo; 메뉴를 8번 연속 누르면 열립니다.</Notice>
        <RecoveryStatsPanel />
        <EduDocSection />
        <Card aria-labelledby="admin-links-title">
          <h2 id="admin-links-title" className="text-[17px] font-bold">
            다른 관리 도구
          </h2>
          <a
            href="/admin/"
            target="_blank"
            rel="noreferrer"
            className="mt-3 flex min-h-12 items-center gap-3 rounded-xl bg-fill px-4 py-3.5 text-[15px] font-semibold transition-colors hover:bg-line/60 active:bg-line"
          >
            <Icon name="shield" className="size-5 text-mute-weak" />
            <span className="flex-1">Django 관리자 (계정·주문·리포트·알림 표)</span>
            <Icon name="chevron" className="size-4 text-mute-weak" />
          </a>
        </Card>
      </div>
    </>
  );
}
