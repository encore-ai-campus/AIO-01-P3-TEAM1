// 쉬운 보기 리포트의 AI 글(쉬운 요약·근거·위험·틀리는 경우·조사 요약)에 나오는 전문 용어에 용어 풀이(components/Term.tsx)를 붙인다 (UX-4 화면 쪽).
// 화면 고정 사전(lib/glossary.ts)에 없는 AI 글 용어(이동평균선·지지선·저항선·등락률·밸류에이션)는 여기에 둔다. 권유·예측 표현을 쓰지 않는다 (docs/API.md "금지 표현").
// 한 화면에서 용어마다 처음 나온 한 번만 풀이를 붙인다 (같은 용어에 밑줄이 줄마다 생기지 않게).
// 글 안에서 이미 풀이한 용어("이동평균선(최근 며칠 평균 가격)" — 새 리포트는 서버 backend/reports/guardrails/tidy.py가 괄호 풀이를 붙인다)에는 붙이지 않고,
// 풀이가 나온 것으로 본다 (뒤에 다시 나와도 붙이지 않는다). 괄호 풀이가 없는 옛 리포트에는 지금처럼 붙인다.
import { GLOSSARY, type GlossaryEntry, type GlossaryKey } from "./glossary";

const entry = (term: string, short: string): GlossaryEntry => ({ term, short, tier: "P0" });

/** AI 글에만 나오는 용어 (화면 고정 문구에는 쓰지 않는다). */
export const REPORT_TERMS = {
  이동평균선: entry(
    "이동평균선",
    "최근 며칠 종가의 평균을 이은 선이에요(20일선 등). 가격이 이 선 위에 있으면 최근 평균보다 비싸게, 아래면 싸게 거래되고 있다는 뜻이에요.",
  ),
  지지선: entry("지지선", "지난 기간에 가격이 여러 번 내려왔다가 멈춘 가격대예요. 이 아래로 내려가면(이탈) 더 내려갈 수 있다고 보는 사람이 많아요."),
  저항선: entry("저항선", "지난 기간에 가격이 여러 번 올라갔다가 막힌 가격대예요. 이 위로 올라서면(돌파) 흐름이 바뀌었다고 보는 사람이 많아요."),
  등락률: entry("등락률", "정한 기간 동안 가격이 몇 % 오르거나 내렸는지예요. 20일 등락률 −12%는 20거래일 전보다 12% 낮다는 뜻이에요."),
  밸류에이션: entry("밸류에이션", "회사의 이익·자산에 비해 주가가 비싼지 싼지 따져 보는 것이에요. PER·PBR 같은 숫자로 보고, '부담'은 비싸 보인다는 뜻이에요."),
} as const satisfies Record<string, GlossaryEntry>;

export type ReportTermKey = keyof typeof REPORT_TERMS;
/** Term이 받는 키: 화면 고정 사전 + AI 글 용어. */
export type TermKey = GlossaryKey | ReportTermKey;

/** 용어 풀이 찾기 (Term). */
export function termEntry(k: TermKey): GlossaryEntry {
  return k in REPORT_TERMS ? REPORT_TERMS[k as ReportTermKey] : GLOSSARY[k as GlossaryKey];
}

/** AI 글에서 찾을 용어 (긴 것부터 — "이동평균선"이 "이동평균"보다 먼저). 영문 약어는 앞뒤에 다른 영문자가 붙지 않은 것만. */
const PATTERNS: { key: TermKey; re: RegExp }[] = [
  { key: "이동평균선", re: /이동\s?평균선?|\d+일\s?이동평균선?/ },
  { key: "지지선", re: /지지선/ },
  { key: "저항선", re: /저항선/ },
  { key: "등락률", re: /등락률/ },
  { key: "밸류에이션", re: /밸류에이션/ },
  { key: "RSI", re: /(?<![A-Za-z])RSI(?![A-Za-z])/ },
  { key: "PER", re: /(?<![A-Za-z])PER(?![A-Za-z])/ },
  { key: "PBR", re: /(?<![A-Za-z])PBR(?![A-Za-z])/ },
  { key: "ROE", re: /(?<![A-Za-z])ROE(?![A-Za-z])/ },
  { key: "변동성", re: /변동성/ },
  { key: "손익비", re: /손익비/ },
  { key: "거래대금", re: /거래대금/ },
  { key: "수급", re: /수급/ },
  { key: "부채비율", re: /부채\s?비율/ },
  { key: "영업이익률", re: /영업\s?이익률/ },
  { key: "유동비율", re: /유동\s?비율/ },
  { key: "이자보상배율", re: /이자\s?보상\s?배율/ },
  { key: "영업현금흐름", re: /영업\s?현금\s?흐름/ },
];

/** 그릴 조각: 글자 그대로 또는 풀이를 붙일 용어 (text는 글에 쓰인 그대로 — "20일 이동평균선"). */
export type TermSegment = string | { key: TermKey; text: string };

/** 글 하나에서 아직 나오지 않은 용어마다 처음 한 번만 용어 조각으로 (seen을 채운다). */
function segmentsOf(text: string, seen: Set<TermKey>): TermSegment[] {
  const found: { start: number; end: number; key: TermKey }[] = [];
  for (const { key, re } of PATTERNS) {
    if (seen.has(key)) continue;
    const m = re.exec(text);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    // 바로 뒤에 괄호 풀이가 있으면 이미 풀이한 용어다 ("RSI(14)"처럼 숫자로 시작하는 괄호는 풀이가 아니다)
    if (/^\s?[(（](?!\s?\d)/.test(text.slice(end))) {
      seen.add(key);
      continue;
    }
    // 먼저 찾은(긴) 용어와 겹치면 건너뛴다
    if (found.some((f) => start < f.end && f.start < end)) continue;
    found.push({ start, end, key });
    seen.add(key);
  }
  found.sort((a, b) => a.start - b.start);
  const out: TermSegment[] = [];
  let at = 0;
  for (const f of found) {
    if (f.start > at) out.push(text.slice(at, f.start));
    out.push({ key: f.key, text: text.slice(f.start, f.end) });
    at = f.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * 화면에 나오는 순서대로 준 AI 글들에 용어 조각을 만든다: 용어마다 처음 나온 글에서 한 번만.
 * 같은 글이 두 번 오면 처음 것의 조각을 쓴다 (화면은 글로 찾는다 — components/reports/easy/AiText).
 */
export function linkTerms(texts: readonly (string | null | undefined)[]): Map<string, TermSegment[]> {
  const seen = new Set<TermKey>();
  const out = new Map<string, TermSegment[]>();
  for (const t of texts) {
    if (!t || out.has(t)) continue;
    out.set(t, segmentsOf(t, seen));
  }
  return out;
}
