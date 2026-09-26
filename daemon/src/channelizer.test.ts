import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUDIO_RATE, Channelizer } from './channelizer.ts';
import { bandEnergyDb } from './detector.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

interface Carrier {
  offsetHz: number;
  /** 调制音。没有就是空载波。 */
  toneHz?: number;
  devHz?: number;
  amp: number;
}

/** 合成一段 rtl_sdr 的输出：几个调频载波加噪声，无符号 8 位，I 和 Q 交替。 */
function iq(seconds: number, rate: number, carriers: Carrier[], noise = 20, seed = 3): Uint8Array {
  const r = rng(seed);
  const n = Math.round(seconds * rate);
  const out = new Uint8Array(n * 2);
  for (let k = 0; k < n; k++) {
    const t = k / rate;
    let i = 0;
    let q = 0;
    for (const c of carriers) {
      const mod = c.toneHz ? ((c.devHz ?? 3000) / c.toneHz) * Math.sin(2 * Math.PI * c.toneHz * t) : 0;
      const ph = 2 * Math.PI * c.offsetHz * t + mod;
      i += c.amp * Math.cos(ph);
      q += c.amp * Math.sin(ph);
    }
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v + 127.5)));
    out[2 * k] = clamp(i + r() * noise);
    out[2 * k + 1] = clamp(q + r() * noise);
  }
  return out;
}

/** 跳过开头 0.1 秒，滤波器和鉴频器要一两个样点才稳。 */
const steady = (a: Int16Array) => a.subarray(AUDIO_RATE / 10);
const band = (a: Int16Array, lo: number, hi: number) => bandEnergyDb(steady(a), AUDIO_RATE, lo, hi);

describe('Channelizer', () => {
  it('每个信道只听得到自己那个载波上的声音', () => {
    const rate = 1_200_000;
    const data = iq(0.5, rate, [
      { offsetHz: -253_000, toneHz: 1000, amp: 40 },
      { offsetHz: 222_000, toneHz: 700, amp: 40 },
    ]);
    const [a, b] = new Channelizer(rate, [-253_000, 222_000]).push(data);

    assert.ok(band(a!, 950, 1050) - band(a!, 650, 750) > 20, '第一个信道里 700 Hz 太响');
    assert.ok(band(b!, 650, 750) - band(b!, 950, 1050) > 20, '第二个信道里 1 kHz 太响');
  });

  // 静噪判据就是这个：有载波时鉴频器输出的高频噪声塌下去。
  it('有载波的信道噪声带塌下去，隔壁 25 kHz 的空信道不跟着塌', () => {
    const rate = 1_200_000;
    const data = iq(0.5, rate, [{ offsetHz: 125_000, amp: 60 }]);
    const [on, next, far] = new Channelizer(rate, [125_000, 150_000, -300_000]).push(data);
    const noise = (a: Int16Array) => band(a, 5000, 9000);

    assert.ok(noise(far!) - noise(on!) > 20, `有载波只低了 ${(noise(far!) - noise(on!)).toFixed(1)} dB`);
    assert.ok(Math.abs(noise(next!) - noise(far!)) < 3, `隔壁信道差了 ${(noise(next!) - noise(far!)).toFixed(1)} dB`);
  });

  it('怎么切段喂都一样，I 和 Q 被拆开也一样', () => {
    const rate = 1_200_000;
    const data = iq(0.2, rate, [{ offsetHz: -40_000, toneHz: 1000, amp: 40 }]);
    const whole = new Channelizer(rate, [-40_000]).push(data)[0]!;

    const c = new Channelizer(rate, [-40_000]);
    const parts: Int16Array[] = [];
    for (let i = 0; i < data.length; i += 1001) parts.push(c.push(data.subarray(i, i + 1001))[0]!);
    const pieced = Int16Array.from(parts.flatMap((p) => Array.from(p)));

    assert.deepEqual(pieced, whole);
  });

  it('两档采样率都出 24 kHz 的音频', () => {
    for (const rate of [1_200_000, 2_400_000]) {
      const out = new Channelizer(rate, [50_000]).push(iq(1, rate, [], 20))[0]!;
      assert.equal(out.length, AUDIO_RATE);
    }
  });

  it('采样率不是 24 kHz 的整数倍就不干', () => {
    assert.throws(() => new Channelizer(1_000_000, [0]));
  });
});
