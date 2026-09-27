/**
 * 电台此刻的样子，一个信道一条。一支接收机守几个信道，就报几条。
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
  /** rtl_sdr 最后说的那句话。它起不来的时候，唯一的线索就是这个。 */
  lastError?: string;
  /** rtl_sdr 重开了多少次。一直涨说明它根本起不来。 */
  restarts?: number;
  at: number;
}

/** 超过这么久没报就当收不到了。守护进程每秒一次，留足余量。 */
export const STALE_S = 10;

export interface RadioView extends RadioStatus {
  /** 距离上一次报过去了多少秒。 */
  ageS: number;
  /** 还算不算新鲜。不新鲜说明守护进程或者 rtl_sdr 出事了。 */
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

/**
 * 收下一批状态，一个信道一条。形状不对的那条就当没收到，这条路上的东西
 * 不值得让请求失败。以前只守一个信道时报的是单个对象，也照样认。
 */
export function parseRadio(raw: unknown, now: number): RadioStatus[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((r) => parseOne(r, now)).filter((r): r is RadioStatus => r !== undefined);
}

function parseOne(raw: unknown, now: number): RadioStatus | undefined {
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

/**
 * 模拟守听是不是有效地开着。判的是配置，不是「保存时清一次状态」：一个正在
 * 停下来的守护进程可能还有一两批在途的状态，清状态挡不住它们把旧信道带回来，
 * 只有在读的这一刻按配置过一遍才行。
 */
export function analogEffectivelyOn(analog: { enabled?: boolean } | undefined): boolean {
  return analog !== undefined && analog.enabled !== false;
}

/**
 * /api/radios 和 /api/ops 共用同一个函数，两边才不会说法不一样：关着的时候
 * 一律是空数组，不是把上一批状态一直摆在那里。
 */
export function radiosOf(state: { view(now: number): RadioView[] }, analogEnabled: boolean, now: number): RadioView[] {
  return analogEnabled ? state.view(now) : [];
}

export function createRadioState() {
  let latest: RadioStatus[] | undefined;
  /** 每个信道这次守听里离门限最近的一刻。 */
  let closest = new Map<string, number>();

  const key = (s: RadioStatus) => `${s.freqMhz}|${s.channel}`;

  return {
    /** 一批就是全部信道。换了信道表，不在新表里的那些连同最接近值一起丢掉。 */
    set(list: RadioStatus[]): void {
      if (list.length === 0) return;
      const next = new Map<string, number>();
      for (const s of list) {
        // 同一个信道接着记。换了频率或者信道名就重新记，上一个频点的最接近值
        // 说明不了这个频点。
        let c = closest.get(key(s));
        if (s.noiseDb !== undefined && s.openBelowDb !== undefined) {
          const margin = s.noiseDb - s.openBelowDb;
          if (c === undefined || margin < c) c = margin;
        }
        if (c !== undefined) next.set(key(s), c);
      }
      closest = next;
      latest = list;
    },
    /** 没有守听、或者从没报上来过时是空的。 */
    view(now: number): RadioView[] {
      return (latest ?? []).map((s) => {
        // 两个进程的秒取整会差一拍，负数看着像出了错。
        const ageS = Math.max(0, now - s.at);
        const c = closest.get(key(s));
        return {
          ...s,
          ageS,
          fresh: ageS <= STALE_S,
          // 分贝读数留一位，后面十几位是浮点噪声。
          closestDb: c === undefined ? undefined : Math.round(c * 10) / 10,
        };
      });
    },
  };
}
