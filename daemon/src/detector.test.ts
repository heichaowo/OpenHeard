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

/** 噪声本底比 noiseBlock 高或低 db 分贝。 */
function floorBlock(db: number, seed = 1): Float64Array {
  const k = 10 ** (db / 20);
  return noiseBlock(seed).map((v) => v * k);
}

/** 有载波：高频噪声塌掉，只剩话音。 */
function carrierBlock(seed = 2, voiceAmp = 4000, hiss = 60): Float64Array {
  const r = rng(seed);
  return Float64Array.from({ length: N }, (_, i) =>
    voiceAmp * Math.sin((2 * Math.PI * 1000 * i) / FS) + r() * hiss,
  );
}

/** 余量和生产一样是 12 和 7。校准、跟踪和强制关闭都缩短，测试才跑得完。 */
const CFG = {
  sampleRate: FS,
  calibrateS: 0.5,
  openMarginDb: 12,
  closeMarginDb: 7,
  minDurationS: 0.3,
  trackS: 2,
  maxOpenS: 10,
};
const CAL_BLOCKS = 10;

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
  /** 先喂一段纯噪声定基准，再从 t0 起喂 blocks。flush 为假时不收尾，看得到最后的状态。 */
  const feed = (d: SquelchDetector, blocks: Float64Array[], t0 = 1000, flush = true) => {
    for (let i = 0; i < CAL_BLOCKS; i++) {
      d.push(noiseBlock(1000 + i), t0 - (CAL_BLOCKS - i) * BLOCK, BLOCK);
    }
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const e = d.push(blocks[i]!, t0 + i * BLOCK, BLOCK);
      if (e) out.push(e);
    }
    const last = flush ? d.flush() : undefined;
    if (last) out.push(last);
    return out;
  };
  const many = (k: number, make: (i: number) => Float64Array) => Array.from({ length: k }, (_, i) => make(i));

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
    // 丢掉的也要数上，否则「开过但太短」和「从没开过」在小结里分不出来
    assert.deepEqual(d.counts, { opened: 1, short: 1, forced: 0 });
  });

  it('迟滞挡住门限附近的抖动，不切成一串碎事件', () => {
    const d = new SquelchDetector(CFG);
    // 噪声带落在两个门限之间时应当维持已打开的状态。门限是基准下 12 和 7。
    const marginal = () => floorBlock(-9.5, 9);
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

  it('校准完之前不判，基准出来之后才有门限', () => {
    const d = new SquelchDetector(CFG);
    for (let i = 0; i < CAL_BLOCKS - 1; i++) d.push(carrierBlock(i), 1000 + i * BLOCK, BLOCK);
    assert.equal(d.idleDb, undefined);
    assert.equal(d.isOpen, false);
    d.push(noiseBlock(1), 1000 + CAL_BLOCKS * BLOCK, BLOCK);
    assert.notEqual(d.idleDb, undefined);
  });

  // 438.500 上本底一天里在 88 到 97 dB 之间变。基准不跟着落的话，本底落进
  // 两个门限中间，静噪一打开就关不上。
  it('本底落下来以后，静噪照样关得上', () => {
    const d = new SquelchDetector(CFG);
    const low = (i: number) => floorBlock(-9, 300 + i);
    const out = feed(d, [...many(60, low), ...many(20, (i) => carrierBlock(i + 400)), ...many(10, low)], 1000, false);

    assert.equal(d.isOpen, false);
    assert.equal(out.length, 1);
    assert.ok(Math.abs(out[0]!.durationS - 20 * BLOCK) < 1e-9);
    assert.equal(out[0]!.forced, undefined);
  });

  // 基准不跟着涨的话，信号要比本底低 12 dB 再加上涨的那 9 dB 才打得开。
  it('本底涨上去以后，门限跟着涨，弱一点的信号照样打得开', () => {
    const d = new SquelchDetector(CFG);
    const high = (i: number) => floorBlock(9, 500 + i);
    const weak = (i: number) => floorBlock(9 - 14, 600 + i);
    const out = feed(d, [...many(60, high), ...many(20, weak), ...many(10, high)], 1000, false);

    assert.equal(out.length, 1);
    assert.ok(Math.abs(out[0]!.durationS - 20 * BLOCK) < 1e-9);
  });

  it('开着的时候不挪基准，一次长发射不会把自己算成本底', () => {
    const d = new SquelchDetector(CFG);
    feed(d, [], 1000, false);
    const idle = d.idleDb;
    // 5 秒载波，比 trackS 长，比 maxOpenS 短
    for (let i = 0; i < 100; i++) {
      d.push(carrierBlock(i + 700), 1000 + i * BLOCK, BLOCK);
      assert.equal(d.idleDb, idle);
    }
    assert.equal(d.isOpen, true);
  });

  // 2026-09-25 那次：基准偏高，静噪打开后本底落在两个门限中间，93 分钟后崩掉。
  it('卡在两个门限中间开着不关的，到 maxOpenS 强制关一次，之后回到正常', () => {
    const d = new SquelchDetector(CFG);
    const stuck = (i: number) => floorBlock(-9.5, 800 + i);
    const out = feed(
      d,
      [
        ...many(10, (i) => carrierBlock(i + 900)),
        ...many(400, stuck),
        ...many(20, (i) => carrierBlock(i + 950)),
        ...many(10, stuck),
      ],
      1000,
      false,
    );

    assert.equal(d.isOpen, false);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.forced, true);
    assert.ok(Math.abs(out[0]!.durationS - CFG.maxOpenS) <= BLOCK + 1e-9);
    assert.equal(out[1]!.forced, undefined);
    assert.ok(Math.abs(out[1]!.durationS - 20 * BLOCK) < 1e-9);
    assert.equal(d.counts.forced, 1);
  });

  // 真有一个很长的发射时，噪声一直压得很低。按它重定基准的话，基准落到载波
  // 自己的水平，这次剩下的部分和紧跟着的下一次都听不见。
  it('长过 maxOpenS 的发射切成几段记下来，基准不动，紧跟着的下一次照样认得出', () => {
    const d = new SquelchDetector(CFG);
    feed(d, [], 1000, false);
    const idle = d.idleDb;
    const blocks = [
      ...many(240, (i) => carrierBlock(i + 1100)),
      ...many(10, (i) => noiseBlock(i + 1500)),
      ...many(20, (i) => carrierBlock(i + 1600)),
      ...many(10, (i) => noiseBlock(i + 1700)),
    ];
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const e = d.push(blocks[i]!, 1000 + i * BLOCK, BLOCK);
      if (e) out.push(e);
    }

    assert.equal(d.idleDb, idle);
    assert.equal(out.length, 3);
    assert.equal(out[0]!.forced, true);
    assert.ok(Math.abs(out[0]!.durationS - CFG.maxOpenS) <= BLOCK + 1e-9);
    // 第二段接着第一段，中间不丢块
    assert.ok(Math.abs(out[1]!.startAt - (out[0]!.startAt + out[0]!.durationS)) < 1e-9);
    assert.ok(Math.abs(out[0]!.durationS + out[1]!.durationS - 240 * BLOCK) < 1e-9);
    // 间隔半秒，比 trackS 短得多
    assert.ok(Math.abs(out[2]!.durationS - 20 * BLOCK) < 1e-9);
  });

  it('一直不断的载波连着强制关两次就按它重定基准，不会每 maxOpenS 刷一条', () => {
    const d = new SquelchDetector(CFG);
    const out = feed(
      d,
      [
        ...many(600, (i) => carrierBlock(i + 1100)),
        ...many(60, (i) => noiseBlock(i + 1800)),
        ...many(20, (i) => carrierBlock(i + 1900)),
        ...many(10, (i) => noiseBlock(i + 1950)),
      ],
      1000,
      false,
    );

    assert.equal(out.filter((e) => e.forced).length, 2);
    // 载波走了之后基准回到本底，下一次发射照样认得出来
    assert.equal(out.length, 3);
    assert.ok(Math.abs(out[2]!.durationS - 20 * BLOCK) < 1e-9);
  });
});
