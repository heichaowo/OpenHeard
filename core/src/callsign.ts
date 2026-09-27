/** 去空格并转大写。ADIF 的呼号一律大写。 */
export function normalizeCallsign(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

/**
 * 宽松校验：只挡明显打错的，不做 ITU 前缀判定。
 * 允许 BG0CG、BG0CG/P、VP2E/BG0CG 这类带斜杠的形式。
 */
export function isValidCallsign(input: string): boolean {
  const call = normalizeCallsign(input);
  if (call.length < 3 || call.length > 20) return false;
  if (!/^[A-Z0-9]+(\/[A-Z0-9]+)*$/.test(call)) return false;
  return /[0-9]/.test(call) && /[A-Z]/.test(call);
}

/**
 * 前缀匹配的范围查询边界：`[p, pNext)`。用范围而不是 LIKE，因为 LIKE 把
 * normalizeCallsign 留下的 `%` 和 `_` 当成通配符，而范围谓词才用得上
 * `callsign` 上的索引（LIKE 'x%' 虽然也能走索引，但前缀带通配符时就退化
 * 成整表扫描，range 谓词没有这个坑）。
 */
export function prefixRange(prefix: string): [string, string] {
  const last = prefix.charCodeAt(prefix.length - 1);
  return [prefix, prefix.slice(0, -1) + String.fromCharCode(last + 1)];
}
