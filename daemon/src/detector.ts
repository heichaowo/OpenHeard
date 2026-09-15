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
  samples: Float64Array | number[],
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
  /** 噪声带能量低于它算静噪打开。 */
  openBelowDb: number;
  /** 高于它算关闭。和上面留出迟滞，防止门限附近抖动切出一串碎事件。 */
  closeAboveDb: number;
  /** 短于这个时长的丢掉。弱信号短暂顶开静噪不是一次发射。 */
  minDurationS: number;
}

export interface SquelchEvent {
  /** Unix 秒。 */
  startAt: number;
  durationS: number;
  /** 话音带减噪声带，用来推 RST 的 R。 */
  audioSnrDb: number;
}

const NOISE_LO = 5000;
const NOISE_HI = 9000;
const VOICE_LO = 300;
const VOICE_HI = 3000;

/**
 * 逐块喂音频，吐出发射事件。
 *
 * 调用方负责给出每一块的起始时刻，这样测试里不用碰时钟。
 */
export class SquelchDetector {
  #cfg: DetectorConfig;
  #open = false;
  #startAt = 0;
  #endAt = 0;
  #snr: number[] = [];

  constructor(cfg: DetectorConfig) {
    this.#cfg = cfg;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** 喂一块音频。块的时长由调用方保证一致。返回这一块结束时闭合的事件。 */
  push(samples: Float64Array | number[], atUnix: number, blockS: number): SquelchEvent | undefined {
    const noise = bandEnergyDb(samples, this.#cfg.sampleRate, NOISE_LO, NOISE_HI);
    const voice = bandEnergyDb(samples, this.#cfg.sampleRate, VOICE_LO, VOICE_HI);

    if (!this.#open) {
      if (noise < this.#cfg.openBelowDb) {
        this.#open = true;
        this.#startAt = atUnix;
        this.#endAt = atUnix + blockS;
        this.#snr = [voice - noise];
      }
      return undefined;
    }

    if (noise <= this.#cfg.closeAboveDb) {
      this.#endAt = atUnix + blockS;
      this.#snr.push(voice - noise);
      return undefined;
    }
    return this.#close();
  }

  /** 流断了或者停机时收尾，别把最后一次发射吞掉。 */
  flush(): SquelchEvent | undefined {
    return this.#open ? this.#close() : undefined;
  }

  #close(): SquelchEvent | undefined {
    const durationS = this.#endAt - this.#startAt;
    const snr = this.#snr;
    this.#open = false;
    this.#snr = [];
    if (durationS < this.#cfg.minDurationS) return undefined;
    return {
      startAt: this.#startAt,
      durationS,
      audioSnrDb: snr.reduce((a, b) => a + b, 0) / Math.max(1, snr.length),
    };
  }
}
