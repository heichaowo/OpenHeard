/**
 * 登录口的限速。
 *
 * 只有一个口令，没有账号，所以猜中一次就是全部。host 配成 0.0.0.0 之后
 * 同一个局域网上任何设备都够得着这个口，而 scrypt 那点开销挡不住什么：
 * 实测一次失败登录 58 毫秒，一天能试 150 万次。
 *
 * 按来源地址计数，一个窗口内超了就回 429。存在内存里，进程重启就清零 ——
 * 这是一个人自己的机器，不值得为它加一张表。
 */

export interface Throttle {
  /** 还能不能试。超了返回还要等多少秒。 */
  check: (key: string, now: number) => { ok: true } | { ok: false; retryAfterS: number };
  /** 登录成功之后把这个来源的计数清掉。 */
  clear: (key: string) => void;
}

export interface ThrottleOptions {
  /** 窗口长度，毫秒。 */
  windowMs: number;
  /** 一个窗口内最多几次。 */
  max: number;
  /** 最多记多少个来源，防止被大量伪造地址撑爆内存。 */
  maxKeys?: number;
}

export function createThrottle({ windowMs, max, maxKeys = 1024 }: ThrottleOptions): Throttle {
  const hits = new Map<string, { n: number; resetAt: number }>();

  return {
    check(key, now) {
      const seen = hits.get(key);
      if (seen === undefined || seen.resetAt <= now) {
        hits.set(key, { n: 1, resetAt: now + windowMs });
        // 顺手扔掉过期的。没有定时器，所以只在写的时候清。
        if (hits.size > maxKeys) {
          for (const [k, v] of hits) {
            if (v.resetAt <= now) hits.delete(k);
            if (hits.size <= maxKeys) break;
          }
          // 全都没过期就从最早的开始扔。
          while (hits.size > maxKeys) {
            const oldest = hits.keys().next().value;
            if (oldest === undefined) break;
            hits.delete(oldest);
          }
        }
        return { ok: true };
      }

      seen.n += 1;
      if (seen.n > max) {
        return { ok: false, retryAfterS: Math.max(1, Math.ceil((seen.resetAt - now) / 1000)) };
      }
      return { ok: true };
    },

    clear(key) {
      hits.delete(key);
    },
  };
}
