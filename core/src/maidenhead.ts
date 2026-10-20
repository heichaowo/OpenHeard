/**
 * Maidenhead 网格。按 WGS-84 算：高德给的 GCJ-02 坐标要先用 gcj02.ts 换回来，
 * 直接拿去算 6 位网格约 9% 的地方会错一格，8 位网格近 70%。
 */

export type GridLength = 4 | 6 | 8;

/** 整数单位：经度每度 2880 份，纬度每度 5760 份，格边正好落在整数上，不吃浮点误差。 */
const LON_UNITS = 2880;
const LAT_UNITS = 5760;
const LON_TOTAL = 360 * LON_UNITS;
const LAT_TOTAL = 180 * LAT_UNITS;

/** 每一对字符：一份有多少个整数单位，一共多少档。字母档 A 起，数字档 0 起。 */
const LEVELS = [
  { unit: 57600, count: 18, letter: true },
  { unit: 5760, count: 10, letter: false },
  { unit: 240, count: 24, letter: true },
  { unit: 24, count: 10, letter: false },
] as const;

const charOf = (n: number, letter: boolean) => (letter ? String.fromCharCode(65 + n) : String(n));

/** 坐标所在的网格。纬度 90 和经度 180 落进最后一格，不溢出。 */
export function toGrid(lat: number, lon: number, length: 6 | 8 = 6): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new RangeError(`坐标越界：${lat}, ${lon}`);
  }
  const x = Math.min(Math.floor((lon + 180) * LON_UNITS), LON_TOTAL - 1);
  const y = Math.min(Math.floor((lat + 90) * LAT_UNITS), LAT_TOTAL - 1);
  let out = '';
  for (const lv of LEVELS.slice(0, length / 2)) {
    out += charOf(Math.floor(x / lv.unit) % lv.count, lv.letter);
    out += charOf(Math.floor(y / lv.unit) % lv.count, lv.letter);
  }
  return out;
}

/** 4、6 或 8 位，大小写都认：AA–RR、00–99、AA–XX、00–99。 */
export function isValidGrid(grid: string): boolean {
  return /^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$/i.test(grid);
}

export interface GridBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** 网格这一格的四条边，WGS-84 度。 */
export function gridBounds(grid: string): GridBounds {
  if (!isValidGrid(grid)) throw new RangeError(`不是网格：${grid}`);
  const g = grid.toUpperCase();
  let x = 0;
  let y = 0;
  let unit: number = LEVELS[0].unit;
  for (let i = 0; i < g.length / 2; i++) {
    const lv = LEVELS[i]!;
    const a = g.charCodeAt(i * 2);
    const b = g.charCodeAt(i * 2 + 1);
    x += (lv.letter ? a - 65 : a - 48) * lv.unit;
    y += (lv.letter ? b - 65 : b - 48) * lv.unit;
    unit = lv.unit;
  }
  return {
    south: y / LAT_UNITS - 90,
    west: x / LON_UNITS - 180,
    north: (y + unit) / LAT_UNITS - 90,
    east: (x + unit) / LON_UNITS - 180,
  };
}

/** 这一格的中心。 */
export function gridCenter(grid: string): { lat: number; lon: number } {
  const b = gridBounds(grid);
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}
