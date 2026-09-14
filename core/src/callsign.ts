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
