/**
 * 把接收机的一路 IQ 采样拆成几个信道，各自鉴频成 24 kHz 的音频。
 *
 * 每个信道：乘一个复指数把它挪到零频，用两级滑动平均叠成的三角窗抽取到
 * 24 kHz，再按相邻两个样点的相位差鉴频。rtl_fm 用的是单级滑动平均，三角窗
 * 旁瓣低一倍的分贝数，旁边信道漏进来的少。缩放和 rtl_fm 一样：相位差除以 π
 * 再乘 2^14，所以静噪判据和 MDC 解码拿到的音频和以前是一个量级。
 */

export const AUDIO_RATE = 24_000;

interface Chan {
  stepRe: number;
  stepIm: number;
  phRe: number;
  phIm: number;
  /** 这一块里已经进了几个样点。 */
  n: number;
  /** 这一块的 Σx 和 Σi·x。 */
  s0Re: number;
  s0Im: number;
  s1Re: number;
  s1Im: number;
  /** 上一块在三角窗上升那一半的贡献，等这一块下降那一半补齐就出一个样点。 */
  riseRe: number;
  riseIm: number;
  /** 上一个抽取后的样点，鉴频要用。 */
  prevRe: number;
  prevIm: number;
}

export class Channelizer {
  readonly #d: number;
  readonly #chans: Chan[];
  /** rtl_sdr 按字节吐，I 和 Q 可能被拆在两段里。 */
  #carry: number | undefined;

  constructor(sampleRate: number, offsetsHz: number[]) {
    const d = sampleRate / AUDIO_RATE;
    if (!Number.isInteger(d)) throw new Error(`采样率 ${sampleRate} 不是 ${AUDIO_RATE} 的整数倍`);
    this.#d = d;
    this.#chans = offsetsHz.map((f) => {
      const w = (-2 * Math.PI * f) / sampleRate;
      return {
        stepRe: Math.cos(w),
        stepIm: Math.sin(w),
        phRe: 1,
        phIm: 0,
        n: 0,
        s0Re: 0,
        s0Im: 0,
        s1Re: 0,
        s1Im: 0,
        riseRe: 0,
        riseIm: 0,
        prevRe: 1,
        prevIm: 0,
      };
    });
  }

  /** 喂一段 rtl_sdr 的输出：无符号 8 位，I 和 Q 交替。返回每个信道这一段新出的音频。 */
  push(bytes: Uint8Array): Int16Array[] {
    let data = bytes;
    if (this.#carry !== undefined) {
      data = new Uint8Array(bytes.length + 1);
      data[0] = this.#carry;
      data.set(bytes, 1);
      this.#carry = undefined;
    }
    const pairs = data.length >> 1;
    if (data.length & 1) this.#carry = data[data.length - 1];
    return this.#chans.map((c) => this.#run(c, data, pairs));
  }

  #run(c: Chan, data: Uint8Array, pairs: number): Int16Array {
    const d = this.#d;
    const out = new Int16Array(Math.floor((c.n + pairs) / d));
    let k = 0;
    // 热路径，状态搬进局部变量。
    let { phRe, phIm, n, s0Re, s0Im, s1Re, s1Im, riseRe, riseIm, prevRe, prevIm } = c;
    const { stepRe, stepIm } = c;
    for (let p = 0; p < pairs; p++) {
      const i = data[2 * p]! - 127.5;
      const q = data[2 * p + 1]! - 127.5;
      const xRe = i * phRe - q * phIm;
      const xIm = i * phIm + q * phRe;
      const nextRe = phRe * stepRe - phIm * stepIm;
      phIm = phRe * stepIm + phIm * stepRe;
      phRe = nextRe;
      s0Re += xRe;
      s0Im += xIm;
      s1Re += n * xRe;
      s1Im += n * xIm;
      n += 1;
      if (n < d) continue;

      // 三角窗：上一块按 1..d 升，这一块按 d-1..0 降。
      const yRe = riseRe + (d - 1) * s0Re - s1Re;
      const yIm = riseIm + (d - 1) * s0Im - s1Im;
      riseRe = s1Re + s0Re;
      riseIm = s1Im + s0Im;
      s0Re = s0Im = s1Re = s1Im = 0;
      n = 0;

      const angle = Math.atan2(yIm * prevRe - yRe * prevIm, yRe * prevRe + yIm * prevIm);
      out[k++] = Math.round((angle / Math.PI) * 16384);
      prevRe = yRe;
      prevIm = yIm;

      // 振荡器每一块拉回单位圆，浮点误差不会一路累积成幅度漂移。
      const mag = Math.hypot(phRe, phIm);
      phRe /= mag;
      phIm /= mag;
    }
    Object.assign(c, { phRe, phIm, n, s0Re, s0Im, s1Re, s1Im, riseRe, riseIm, prevRe, prevIm });
    return out;
  }
}
