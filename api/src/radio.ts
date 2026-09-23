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
  /** rtl_fm 最后说的那句话。它起不来的时候，唯一的线索就是这个。 */
  lastError?: string;
  /** rtl_fm 重开了多少次。一直涨说明它根本起不来。 */
  restarts?: number;
  at: number;
}

/** 超过这么久没报就当收不到了。守护进程每秒一次，留足余量。 */
export const STALE_S = 10;

export interface RadioView extends RadioStatus {
  /** 距离上一次报过去了多少秒。 */
  ageS: number;
  /** 还算不算新鲜。不新鲜说明守护进程或者 rtl_fm 出事了。 */
  fresh: boolean;
  /**
   * 这次守听里最接近打开门限的那一刻，差了多少 dB。
   *
   * 运维页 20 秒拉一次，看到的只是那一瞬。光看一个瞬时值答不了
   * 「这个信号到底够不够得着门限」，得记住最接近的那次。换频率就重记。
   */
  closestDb?: number;
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
    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 200) : undefined,
    restarts: num(raw.restarts),
    at: num(raw.at) ?? now,
  };
}

export function createRadioState() {
  let latest: RadioStatus | undefined;
  let closestDb: number | undefined;
  let tunedTo: string | undefined;

  return {
    set(status: RadioStatus): void {
      // 换了频率或者信道就重新记，上一个频点的最接近值说明不了这个频点。
      const key = `${status.freqMhz}|${status.channel}`;
      if (key !== tunedTo) {
        tunedTo = key;
        closestDb = undefined;
      }
      if (status.noiseDb !== undefined && status.openBelowDb !== undefined) {
        const margin = status.noiseDb - status.openBelowDb;
        if (closestDb === undefined || margin < closestDb) closestDb = margin;
      }
      latest = status;
    },
    /** 没有守听、或者报不上来时是 undefined。 */
    view(now: number): RadioView | undefined {
      if (latest === undefined) return undefined;
      // 两个进程的秒取整会差一拍，负数看着像出了错。
      const ageS = Math.max(0, now - latest.at);
      return { ...latest, ageS, fresh: ageS <= STALE_S, closestDb };
    },
  };
}
