import { Link } from "react-router";
import { errorMessage } from "../api/client";
import { useAccount } from "../api/queries";
import { formatKrw, formatRate, formatSignedKrw, trendClass } from "../lib/format";
import { Icon } from "./Icon";
import { Card, ErrorState, Flash, Row, SkeletonCard } from "./ui";

/** 홈의 내 자산 카드: 총자산, 손익·수익률(실시간), 투자금액·현금. */
export function AssetCard() {
  const { data: acc, isPending, isError, error, refetch } = useAccount();
  if (isPending) return <SkeletonCard lines={4} />;
  if (isError) {
    return (
      <Card>
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      </Card>
    );
  }
  return (
    <Card aria-labelledby="asset-title">
      <Link to="/portfolio" className="group -m-2 flex items-center justify-between rounded-xl p-2 hover:bg-fill/60">
        <h2 id="asset-title" className="text-[15px] font-semibold text-sub">
          내 자산
        </h2>
        <Icon name="chevron" className="size-5 text-mute" />
      </Link>
      <p className="mt-1 text-[13px] text-mute">총자산</p>
      <p className="text-[28px] leading-tight font-bold tracking-tight tabular-nums">
        <Flash value={acc.equityKrw}>{formatKrw(acc.equityKrw)}</Flash>
      </p>
      <p className={`mt-1 text-[15px] font-semibold tabular-nums ${trendClass(acc.profitKrw)}`}>
        <Flash value={acc.profitRate}>
          {formatSignedKrw(acc.profitKrw)} ({formatRate(acc.profitRate)})
        </Flash>
      </p>
      <dl className="mt-4 border-t border-line pt-3">
        <Row label="투자금액">{formatKrw(acc.investedKrw)}</Row>
        <Row label="보유 평가액">{formatKrw(acc.holdingsValueKrw)}</Row>
        <Row label="현금">{formatKrw(acc.cashKrw)}</Row>
        {acc.buyingPowerKrw !== null && <Row label="매수 가능액">{formatKrw(acc.buyingPowerKrw)}</Row>}
      </dl>
      {acc.notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-[13px] text-mute">
          {acc.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
