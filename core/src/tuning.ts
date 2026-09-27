/**
 * 一支接收机同时守几个信道时，接收机调到哪、采样率取多少，以及配置里那张
 * 信道表怎么读、怎么验。
 *
 * 守护进程按它读配置、调接收机，api 按它读配置、校验设置，设置页按它当场提示。
 * 三处各验各的话，总有一处放过另外两处不收的东西。决定和理由见 specs/openheard.md。
 */
import { bandOf } from './band.ts';

/** 最高和最低两个信道最多相差多少。 */
export const MAX_SPAN_HZ = 1_800_000;
/** 一支接收机最多拆几个信道。 */
export const MAX_CHANNELS = 8;
/** 两个信道至少隔多远。再近就是同一个信号拆了两遍。 */
export const MIN_SPACING_HZ = 12_500;
/** 信道离中心至少多远。中心上有一根直流尖峰。 */
export const DC_GUARD_HZ = 30_000;
/** 两个信道偏离中心的量加起来至少差多少。正好对称时互为镜像。 */
export const MIRROR_GUARD_HZ = 30_000;

/** 从低到高试。能用小的就用小的，CPU 省一半。 */
const RATES = [1_200_000, 2_400_000];
/** 每档采样率中心两侧能用的宽度：奈奎斯特的 80%，两头留给滤波器滚降。 */
const usable = (rate: number) => rate * 0.4;
const STEP_HZ = 1_000;

export interface TuningPlan {
  centerHz: number;
  sampleRate: number;
  /** 每个信道相对中心的偏移，和传进来的顺序一致。 */
  offsetsHz: number[];
}

export type TuningResult = { ok: true; plan: TuningPlan } | { ok: false; problem: string };

const mhz = (hz: number) => (hz / 1e6).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');

export function planTuning(freqsHz: number[]): TuningResult {
  if (freqsHz.length === 0) return { ok: false, problem: '至少要有一个信道' };
  if (freqsHz.length > MAX_CHANNELS) {
    return { ok: false, problem: `一支接收机最多守 ${MAX_CHANNELS} 个信道` };
  }
  const sorted = [...freqsHz].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! < MIN_SPACING_HZ) {
      return {
        ok: false,
        problem: `${mhz(sorted[i - 1]!)} 和 ${mhz(sorted[i]!)} 挨得太近，至少要隔 ${MIN_SPACING_HZ / 1000} kHz`,
      };
    }
  }
  const lo = sorted[0]!;
  const hi = sorted.at(-1)!;
  if (hi - lo > MAX_SPAN_HZ) {
    return {
      ok: false,
      problem: `最高和最低的信道相差 ${mhz(hi - lo)} MHz，一支接收机最多 ${MAX_SPAN_HZ / 1e6} MHz`,
    };
  }

  const mid = Math.round((lo + hi) / 2 / STEP_HZ) * STEP_HZ;
  for (const rate of RATES) {
    const reach = usable(rate);
    const fits = (c: number) =>
      freqsHz.every((f) => Math.abs(f - c) >= DC_GUARD_HZ && Math.abs(f - c) <= reach) &&
      freqsHz.every((f, i) =>
        freqsHz.every((g, j) => j <= i || Math.abs(f - c + (g - c)) >= MIRROR_GUARD_HZ),
      );
    // 从中点往两边一格一格找，第一个合适的就是离中点最近的。
    for (let k = 0; k * STEP_HZ <= reach; k++) {
      for (const c of k === 0 ? [mid] : [mid - k * STEP_HZ, mid + k * STEP_HZ]) {
        if (fits(c)) {
          return { ok: true, plan: { centerHz: c, sampleRate: rate, offsetsHz: freqsHz.map((f) => f - c) } };
        }
      }
    }
  }
  return { ok: false, problem: '这几个信道找不到一个既避开直流、又不互为镜像的中心频率，换一个信道试试' };
}

export interface AnalogChannel {
  freqMhz: number;
  /** 信道名，进 Activity。 */
  channel: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 读 analog 里的信道表并验它。有一处不对就整张不收，不挑能用的那几个。
 *
 * 以前只能守一个频率，写的是 analog.freqMhz 和 analog.channel。已经装出去的
 * 配置还是那样写，读成只有一个信道的表。
 *
 * @param required 模拟守听关着时传 false：没有信道表不算错，原来配过的
 *   那张表留着不动，界面还要照它填表。有信道表的话照样全验一遍。
 */
export function readAnalogChannels(
  analog: Record<string, unknown>,
  required = true,
): {
  channels?: AnalogChannel[];
  problems: string[];
} {
  const raw = Array.isArray(analog.channels)
    ? analog.channels
    : analog.channels === undefined && analog.freqMhz !== undefined
      ? [{ freqMhz: analog.freqMhz, channel: analog.channel }]
      : [];
  if (raw.length === 0) {
    return required ? { problems: ['analog.channels 至少要有一个信道'] } : { channels: [], problems: [] };
  }

  const problems: string[] = [];
  raw.forEach((c, i) => {
    if (!isObject(c)) return problems.push(`analog.channels[${i}] 不是对象`);
    // 调谐器调不到的频率写进去，守护进程会起来就崩，然后每 5 秒重来一次。
    if (typeof c.freqMhz !== 'number' || bandOf(c.freqMhz) === undefined) {
      problems.push(`analog.channels[${i}].freqMhz 要在 2m 或 70cm 段内`);
    }
    if (typeof c.channel !== 'string' || c.channel === '') problems.push(`analog.channels[${i}].channel 必填`);
  });
  if (problems.length > 0) return { problems };

  const channels = raw as AnalogChannel[];
  const names = channels.map((c) => c.channel);
  if (new Set(names).size !== names.length) return { problems: ['analog.channels 的信道名不能重复'] };
  const plan = planTuning(channels.map((c) => Math.round(c.freqMhz * 1e6)));
  if (!plan.ok) return { problems: [`analog.channels：${plan.problem}`] };
  return { channels: channels.map(({ freqMhz, channel }) => ({ freqMhz, channel })), problems: [] };
}
