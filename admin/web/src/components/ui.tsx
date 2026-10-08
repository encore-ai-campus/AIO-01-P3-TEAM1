import type { ReactNode } from "react";
import type { Level } from "../api";
import type { ApiResult } from "../hooks";
import { DASH, LEVEL_LABEL } from "../format";

export function LevelBadge({ level, label }: { level: Level; label?: string }) {
  return <span className={`badge lv-${level}`}>{label ?? LEVEL_LABEL[level]}</span>;
}

/** 조회 상태(불러오는 중·오류)를 보여 주고, 자료가 있으면 children에 넘긴다. */
export function Loaded<T>({ q, children }: { q: ApiResult<T>; children: (data: T) => ReactNode }) {
  return (
    <>
      {q.error && <div className="notice error">{q.error}</div>}
      {q.data !== undefined ? children(q.data) : q.loading ? <p className="muted">불러오는 중…</p> : null}
    </>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      <div className="page-tools">{children}</div>
    </div>
  );
}

export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Stat({ label, value, sub, level }: { label: string; value: ReactNode; sub?: ReactNode; level?: Level }) {
  return (
    <div className={`stat${level ? ` lv-border-${level}` : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub != null && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Empty({ children = "표시할 내용이 없습니다." }: { children?: ReactNode }) {
  return <p className="muted">{children}</p>;
}

export const orDash = (v: ReactNode | null | undefined) => (v == null || v === "" ? DASH : v);
