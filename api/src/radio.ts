/**
 * 电台此刻的样子。
 *
 * 守护进程每秒报一次，只放在内存里。它描述的是「现在」，重启之后本来就该重新
 * 问一次电台，存进库里没有意义，而且每秒一行会把库撑满。
 *
 * 没有这个的话，「天线听不见」和「没人在发」在界面上长得一模一样，
 * 要分开只能登录到机器上翻日志。
 */
export interface RadioStatus {
  freqMhz: number;
  channel: string;
  gainDb: number;
  idleDb?: number;
  openBelowDb?: number;
  closeAboveDb?: number;
  noiseDb?: number;
  open: boolean;
  lastOpenAt?: number;
  at: number;
}

/** 超过这么久没报就当收不到了。守护进程每秒一次，留足余量。 */
export const STALE_S = 10;

export interface RadioView extends RadioStatus {
  /** 距离上一次报过去了多少秒。 */
  ageS: number;
  /** 还算不算新鲜。不新鲜说明守护进程或者 rtl_fm 出事了。 */
  fresh: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** 收下一条状态。形状不对就当没收到，这条路上的东西不值得让请求失败。 */
export function parseRadio(raw: unknown, now: number): RadioStatus | undefined {
  if (!isObject(raw)) return undefined;
  const freqMhz = num(raw.freqMhz);
  if (freqMhz === undefined || typeof raw.channel !== 'string') return undefined;
  return {
    freqMhz,
    channel: raw.channel,
    gainDb: num(raw.gainDb) ?? 0,
    idleDb: num(raw.idleDb),
    openBelowDb: num(raw.openBelowDb),
    closeAboveDb: num(raw.closeAboveDb),
    noiseDb: num(raw.noiseDb),
    open: raw.open === true,
    lastOpenAt: num(raw.lastOpenAt),
    at: num(raw.at) ?? now,
  };
}

export function createRadioState() {
  let latest: RadioStatus | undefined;

  return {
    set(status: RadioStatus): void {
      latest = status;
    },
    /** 没有守听、或者报不上来时是 undefined。 */
    view(now: number): RadioView | undefined {
      if (latest === undefined) return undefined;
      // 两个进程的秒取整会差一拍，负数看着像出了错。
      const ageS = Math.max(0, now - latest.at);
      return { ...latest, ageS, fresh: ageS <= STALE_S };
    },
  };
}
