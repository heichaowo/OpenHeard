import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SquelchDetector, bandEnergyDb } from './detector.ts';

const FS = 24000;
const BLOCK = 0.05;
const N = FS * BLOCK;

/** 确定性的伪随机，测试不能靠 Math.random。 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/** 无载波：鉴频器输出是宽带噪声，高频带和话音带一样响。 */
function noiseBlock(seed = 1): Float64Array {
  const r = rng(seed);
  return Float64Array.from({ length: N }, () => r() * 8000);
}

/** 有载波：高频噪声塌掉，只剩话音。 */
function carrierBlock(seed = 2, voiceAmp = 4000, hiss = 60): Float64Array {
  const r = rng(seed);
  return Float64Array.from({ length: N }, (_, i) =>
    voiceAmp * Math.sin((2 * Math.PI * 1000 * i) / FS) + r() * hiss,
  );
}

const CFG = { sampleRate: FS, openBelowDb: 60, closeAboveDb: 66, minDurationS: 0.3 };

describe('bandEnergyDb', () => {
  it('把能量算到正确的带里', () => {
    const tone = (hz: number) =>
      Float64Array.from({ length: N }, (_, i) => 1000 * Math.sin((2 * Math.PI * hz * i) / FS));
    const t1k = tone(1000);
    const t7k = tone(7000);
    assert.ok(bandEnergyDb(t1k, FS, 300, 3000) > bandEnergyDb(t1k, FS, 5000, 9000) + 30);
    assert.ok(bandEnergyDb(t7k, FS, 5000, 9000) > bandEnergyDb(t7k, FS, 300, 3000) + 30);
  });

  it('载波把高频噪声带压下去，这就是判据的依据', () => {
    const gap = bandEnergyDb(noiseBlock(), FS, 5000, 9000) - bandEnergyDb(carrierBlock(), FS, 5000, 9000);
    // 实测 438.700 上这个差是 32.5 dB，合成数据只要方向和量级对上
    assert.ok(gap > 20, `噪声带落差只有 ${gap.toFixed(1)} dB`);
  });
});

describe('SquelchDetector', () => {
  const feed = (d: SquelchDetector, blocks: Float64Array[], t0 = 1000) => {
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const e = d.push(blocks[i]!, t0 + i * BLOCK, BLOCK);
      if (e) out.push(e);
    }
    const last = d.flush();
    if (last) out.push(last);
    return out;
  };

  it('全是噪声时什么都不出', () => {
    const d = new SquelchDetector(CFG);
    assert.deepEqual(feed(d, Array.from({ length: 40 }, (_, i) => noiseBlock(i + 1))), []);
    assert.equal(d.isOpen, false);
  });

  it('一次发射出一条事件，起止时间对得上', () => {
    const d = new SquelchDetector(CFG);
    const blocks = [
      ...Array.from({ length: 4 }, (_, i) => noiseBlock(i + 1)),
      ...Array.from({ length: 20 }, (_, i) => carrierBlock(i + 100)),
      ...Array.from({ length: 4 }, (_, i) => noiseBlock(i + 200)),
    ];
    const out = feed(d, blocks);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.startAt, 1000 + 4 * BLOCK);
    assert.ok(Math.abs(out[0]!.durationS - 20 * BLOCK) < 1e-9);
    assert.ok(out[0]!.audioSnrDb > 10, `信噪比 ${out[0]!.audioSnrDb}`);
  });

  it('两次发射之间有静默就是两条事件', () => {
    const d = new SquelchDetector(CFG);
    const n = (k: number) => Array.from({ length: k }, (_, i) => noiseBlock(i + 1));
    const c = (k: number) => Array.from({ length: k }, (_, i) => carrierBlock(i + 50));
    const out = feed(d, [...n(2), ...c(10), ...n(6), ...c(12), ...n(2)]);
    assert.equal(out.length, 2);
    assert.ok(Math.abs(out[0]!.durationS - 0.5) < 1e-9);
    assert.ok(Math.abs(out[1]!.durationS - 0.6) < 1e-9);
  });

  it('太短的丢掉，那是弱信号顶开静噪不是一次发射', () => {
    const d = new SquelchDetector(CFG);
    // 4 块 = 0.2 秒，低于 minDurationS 0.3
    const out = feed(d, [...Array.from({ length: 3 }, (_, i) => noiseBlock(i + 1)),
      ...Array.from({ length: 4 }, (_, i) => carrierBlock(i + 70)),
      ...Array.from({ length: 3 }, (_, i) => noiseBlock(i + 80))]);
    assert.deepEqual(out, []);
  });

  it('迟滞挡住门限附近的抖动，不切成一串碎事件', () => {
    const d = new SquelchDetector(CFG);
    // 噪声带落在两个门限之间时应当维持已打开的状态
    const marginal = () => {
      const r = rng(9);
      return Float64Array.from({ length: N }, (_, i) =>
        4000 * Math.sin((2 * Math.PI * 1000 * i) / FS) + r() * 300,
      );
    };
    const blocks = [
      ...Array.from({ length: 2 }, (_, i) => noiseBlock(i + 1)),
      ...Array.from({ length: 6 }, (_, i) => carrierBlock(i + 30)),
      marginal(), marginal(),
      ...Array.from({ length: 6 }, (_, i) => carrierBlock(i + 40)),
      ...Array.from({ length: 2 }, (_, i) => noiseBlock(i + 90)),
    ];
    const out = feed(d, blocks);
    assert.equal(out.length, 1, '迟滞失效，被切成了多条');
    assert.ok(Math.abs(out[0]!.durationS - 14 * BLOCK) < 1e-9);
  });

  it('流断了也要把最后一次发射交出来', () => {
    const d = new SquelchDetector(CFG);
    const out = feed(d, [
      ...Array.from({ length: 2 }, (_, i) => noiseBlock(i + 1)),
      ...Array.from({ length: 12 }, (_, i) => carrierBlock(i + 60)),
    ]);
    assert.equal(out.length, 1);
    assert.ok(Math.abs(out[0]!.durationS - 0.6) < 1e-9);
  });
});
