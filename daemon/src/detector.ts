// 静噪判决。纯计算，不碰硬件，所以能用合成音频测。
//
// 判据是解调后高频噪声带的能量，不是音量。载波一来鉴频器输出里的高频噪声
// 就塌下去，这是调频静噪一贯的做法。实测依据写在 specs/openheard.md。

/** 原地 radix-2 FFT。只为算两条带的能量，不值得引一个 DSP 库。 */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + len / 2]!;
        const bi = im[i + k + len / 2]!;
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        re[i + k] = ar + tr;
        im[i + k] = ai + ti;
        re[i + k + len / 2] = ar - tr;
        im[i + k + len / 2] = ai - ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const nextPow2 = (n: number) => 1 << Math.ceil(Math.log2(n));

/** 一段音频在 [lo, hi] Hz 之间的平均能量，dB。 */
export function bandEnergyDb(
  samples: ArrayLike<number>,
  sampleRate: number,
  lo: number,
  hi: number,
): number {
  const n = nextPow2(samples.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < samples.length; i++) {
    // 汉宁窗，压住矩形窗的谱泄漏，否则强低频会糊进高频带。
    re[i] = samples[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / samples.length));
  }
  fft(re, im);

  const binHz = sampleRate / n;
  const from = Math.max(1, Math.round(lo / binHz));
  const to = Math.min(n / 2 - 1, Math.round(hi / binHz));
  let sum = 0;
  for (let i = from; i <= to; i++) sum += re[i]! * re[i]! + im[i]! * im[i]!;
  return 10 * Math.log10(sum / Math.max(1, to - from + 1) + 1e-12);
}

export interface DetectorConfig {
  sampleRate: number;
  /** 开头听多久，定第一个基准。 */
  calibrateS: number;
  /** 噪声带比基准低这么多算静噪打开。 */
  openMarginDb: number;
  /** 回到比基准低这么多以内算关闭。和上面留出迟滞，防止门限附近抖动切出一串碎事件。 */
  closeMarginDb: number;
  /** 短于这个时长的丢掉。弱信号短暂顶开静噪不是一次发射。 */
  minDurationS: number;
  /** 静噪关着时，每攒够这么多秒就按这一段重定基准。 */
  trackS: number;
  /** 静噪开着超过这么久就强制关一次，并按这一段重定基准。 */
  maxOpenS: number;
}

export interface SquelchEvent {
  /** Unix 秒。 */
  startAt: number;
  durationS: number;
  /** 话音带减噪声带，用来推 RST 的 R。 */
  audioSnrDb: number;
  /** 开到 maxOpenS 被强制关掉的。可能是一次很长的发射，也可能是基准过时了。 */
  forced?: true;
}

const NOISE_LO = 5000;
const NOISE_HI = 9000;
const VOICE_LO = 300;
const VOICE_HI = 3000;

/** 高分位当基准。有信号时噪声带会塌下去，高分位代表的是没有信号的那部分。 */
const p90 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)]!;

/**
 * 逐块喂音频，吐出发射事件。
 *
 * 开头 calibrateS 秒只用来定基准。之后静噪关着时，每 trackS 秒按这一段重定
 * 一次，所以本底一天里涨落，门限跟着走。开着时不动基准。
 *
 * 开到 maxOpenS 还没关就强制关掉，然后分两种情况。开着这段的噪声大多没低过
 * 开启门限，说明静噪只是靠迟滞撑着，基准过时了，按这一段重定。噪声一直压得
 * 很低，那是真有一个很长的发射，基准不动，下一块照样打开，长发射记成几段。
 * 按它重定的话，基准会落到载波自己的水平，这次发射剩下的部分和紧跟着的
 * 下一次都听不见。连着强制关两次还没停，就按它重定，免得一个一直不松的
 * 发射机每 maxOpenS 刷一条。
 *
 * 调用方负责给出每一块的起始时刻，这样测试里不用碰时钟。
 */
export class SquelchDetector {
  #cfg: DetectorConfig;
  #idle: number | undefined;
  /** 上次定基准以来，静噪关着时每一块的噪声。 */
  #heard: number[] = [];
  /** 这次打开以来每一块的噪声。强制关闭时拿它判断要不要重定基准。 */
  #openNoise: number[] = [];
  /** 连着强制关了几次，中间一块都没关过的才算连着。 */
  #forcedRun = 0;
  #noise: number | undefined;
  #open = false;
  #startAt = 0;
  #endAt = 0;
  #snr: number[] = [];

  /** 累计次数，调用方拿去做小结。 */
  readonly counts = { opened: 0, short: 0, forced: 0 };

  constructor(cfg: DetectorConfig) {
    this.#cfg = cfg;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** 静默基准，dB。还在校准时是 undefined。 */
  get idleDb(): number | undefined {
    return this.#idle;
  }

  get openBelowDb(): number | undefined {
    return this.#idle === undefined ? undefined : this.#idle - this.#cfg.openMarginDb;
  }

  get closeAboveDb(): number | undefined {
    return this.#idle === undefined ? undefined : this.#idle - this.#cfg.closeMarginDb;
  }

  /** 最近一块的噪声带能量。 */
  get noiseDb(): number | undefined {
    return this.#noise;
  }

  /** 喂一块音频。块的时长由调用方保证一致。返回这一块结束时闭合的事件。 */
  push(samples: ArrayLike<number>, atUnix: number, blockS: number): SquelchEvent | undefined {
    const noise = bandEnergyDb(samples, this.#cfg.sampleRate, NOISE_LO, NOISE_HI);
    this.#noise = noise;

    if (this.#idle === undefined) {
      this.#heard.push(noise);
      if (this.#heard.length * blockS >= this.#cfg.calibrateS) this.#rebase(this.#heard);
      return undefined;
    }

    const voice = bandEnergyDb(samples, this.#cfg.sampleRate, VOICE_LO, VOICE_HI);

    if (!this.#open) {
      if (noise < this.#idle - this.#cfg.openMarginDb) {
        this.#open = true;
        this.#startAt = atUnix;
        this.#endAt = atUnix + blockS;
        this.#snr = [voice - noise];
        this.#openNoise = [noise];
        this.counts.opened += 1;
        return undefined;
      }
      // 中间隔了一块没打开，就不算连着强制关。
      this.#forcedRun = 0;
      this.#heard.push(noise);
      if (this.#heard.length * blockS >= this.#cfg.trackS) this.#rebase(this.#heard);
      return undefined;
    }

    if (noise <= this.#idle - this.#cfg.closeMarginDb) {
      this.#endAt = atUnix + blockS;
      this.#snr.push(voice - noise);
      this.#openNoise.push(noise);
      if (this.#endAt - this.#startAt < this.#cfg.maxOpenS) return undefined;
      this.counts.forced += 1;
      this.#forcedRun += 1;
      const heldByHysteresis = p90(this.#openNoise) >= this.#idle - this.#cfg.openMarginDb;
      if (heldByHysteresis || this.#forcedRun >= 2) this.#rebase(this.#openNoise);
      return this.#close(true);
    }
    this.#forcedRun = 0;
    return this.#close();
  }

  /** 流断了或者停机时收尾，别把最后一次发射吞掉。 */
  flush(): SquelchEvent | undefined {
    return this.#open ? this.#close() : undefined;
  }

  #rebase(noise: number[]): void {
    this.#idle = p90(noise);
    this.#heard = [];
    this.#forcedRun = 0;
  }

  #close(forced = false): SquelchEvent | undefined {
    const durationS = this.#endAt - this.#startAt;
    const snr = this.#snr;
    this.#open = false;
    this.#snr = [];
    this.#openNoise = [];
    if (durationS < this.#cfg.minDurationS) {
      this.counts.short += 1;
      return undefined;
    }
    return {
      startAt: this.#startAt,
      durationS,
      audioSnrDb: snr.reduce((a, b) => a + b, 0) / Math.max(1, snr.length),
      ...(forced ? { forced: true as const } : {}),
    };
  }
}
