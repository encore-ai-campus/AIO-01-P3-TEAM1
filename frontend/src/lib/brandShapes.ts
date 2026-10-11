// 로고의 도형 (components/brand/BrandMark.tsx · BrandIntro.tsx가 함께 쓴다). 값을 한 곳에 둬서 아이콘·워드마크·인트로의 ㅁ이 같은 모양으로 유지된다.
// ㅁ: 104 × 96, 속이 빈 사각형(획 32), 아래 변만 살짝 기울임. 아이콘의 블록과 워드마크의 ㅁ은 이 도형 하나를 복사해 쓴다.

/** ㅁ 한 개 (evenodd로 속을 비운다). */
export const MU_PATH = "M0 0H104V88L0 96Z M32 28V60L72 57V28Z";
export const MU_WIDTH = 104;

/** 워드마크 "모매매"의 좌표계 (viewBox 640 × 175). */
export const WORDMARK_VIEWBOX = { width: 640, height: 175 };
/** 세 ㅁ의 자리: 모 / 매 / 매. */
export const WORDMARK_MU = [
  { x: 48, y: 0 },
  { x: 220, y: 40 },
  { x: 440, y: 40 },
] as const;
/** '모'의 ㅗ (세로 줄기 + 받침 가로획). */
export const WORDMARK_MO = ["M84 108H118L116 146H86Z", "M0 146H200V175H0Z"] as const;
/** '매'의 ㅐ (사다리꼴 세로획, 가운데 짧은 획, 오른쪽 세로획). 매는 220, 440에서 시작한다. */
export const WORDMARK_MAE = ["M122 0H156L148 175H116Z", "M150 72H172V96H150Z", "M168 0H200V175H168Z"] as const;
export const WORDMARK_MAE_X = [220, 440] as const;

/** 아이콘(32 격자) 안의 세 블록: 왼쪽 아래에서 오른쪽 위로 오르는 계단. */
export const ICON_BLOCKS = [
  { x: 4.5, y: 18 },
  { x: 12.5, y: 13 },
  { x: 20.5, y: 8 },
] as const;
/** ㅁ(104폭)을 아이콘 블록 크기(약 7)로 줄이는 배율. */
export const ICON_BLOCK_SCALE = 0.0673;
/** 속이 빈 ㅁ을 그리는 가장 작은 크기(px). 더 작으면 속 구멍이 1배율에서 뭉개져 속이 찬 사각형으로 그린다. */
export const HOLLOW_MIN_PX = 32;
