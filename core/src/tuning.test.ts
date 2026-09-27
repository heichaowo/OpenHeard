import { describe, expect, it } from 'vitest';
import { DC_GUARD_HZ, MIRROR_GUARD_HZ, planTuning, readAnalogChannels } from './tuning.ts';

const plan = (...mhz: number[]) => {
  const r = planTuning(mhz.map((m) => Math.round(m * 1e6)));
  if (!r.ok) throw new Error(r.problem);
  return r.plan;
};

describe('planTuning', () => {
  it('一个信道：中心偏开直流，用小的那档采样率', () => {
    const p = plan(438.5);
    expect(p.sampleRate).toBe(1_200_000);
    expect(Math.abs(p.offsetsHz[0]!)).toBe(DC_GUARD_HZ);
  });

  it('438.500 和 438.975：一档 1.2 MHz 就够，两个都避开直流，也不互为镜像', () => {
    const p = plan(438.5, 438.975);
    expect(p.sampleRate).toBe(1_200_000);
    for (const o of p.offsetsHz) {
      expect(Math.abs(o)).toBeGreaterThanOrEqual(DC_GUARD_HZ);
      expect(Math.abs(o)).toBeLessThanOrEqual(480_000);
    }
    // 中点正好让两个信道对称，那样一边会在另一边造出镜像
    expect(Math.abs(p.offsetsHz[0]! + p.offsetsHz[1]!)).toBeGreaterThanOrEqual(MIRROR_GUARD_HZ);
  });

  it('相差超过 480 kHz 两侧的，换 2.4 MHz', () => {
    expect(plan(438.0, 439.5).sampleRate).toBe(2_400_000);
  });

  it('偏移和传进来的顺序一致', () => {
    const p = plan(438.975, 438.5);
    expect(p.centerHz + p.offsetsHz[0]!).toBe(438_975_000);
    expect(p.centerHz + p.offsetsHz[1]!).toBe(438_500_000);
  });

  it('三个等距的信道，中间那个不能落在直流上', () => {
    const p = plan(438.5, 438.7, 438.9);
    expect(Math.min(...p.offsetsHz.map(Math.abs))).toBeGreaterThanOrEqual(DC_GUARD_HZ);
    const o = p.offsetsHz;
    for (let i = 0; i < o.length; i++) {
      for (let j = i + 1; j < o.length; j++) {
        expect(Math.abs(o[i]! + o[j]!)).toBeGreaterThanOrEqual(MIRROR_GUARD_HZ);
      }
    }
  });

  it('差 1.8 MHz 还放得下，再宽就不行，并说清楚为什么', () => {
    expect(plan(438.0, 439.8).sampleRate).toBe(2_400_000);
    const r = planTuning([438_000_000, 439_900_000]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problem).toMatch(/最多 1.8 MHz/);
  });

  it('挨得太近、太多、一个都没有，都拒绝', () => {
    expect(planTuning([438_500_000, 438_505_000]).ok).toBe(false);
    expect(planTuning(Array.from({ length: 9 }, (_, i) => 438_000_000 + i * 25_000)).ok).toBe(false);
    expect(planTuning([]).ok).toBe(false);
  });
});

// 守护进程、api 和设置页都用它读信道表。三处各验各的，就会有一处放过别处不收的东西。
describe('readAnalogChannels', () => {
  it('读出信道表，只留这两个字段', () => {
    const r = readAnalogChannels({
      channels: [
        { freqMhz: 438.5, channel: '438.500 中继', extra: 1 },
        { freqMhz: 438.975, channel: '438.975' },
      ],
    });
    expect(r.problems).toEqual([]);
    expect(r.channels).toEqual([
      { freqMhz: 438.5, channel: '438.500 中继' },
      { freqMhz: 438.975, channel: '438.975' },
    ]);
  });

  it('旧写法读成一个信道', () => {
    expect(readAnalogChannels({ freqMhz: 438.5, channel: 'a' }).channels).toEqual([{ freqMhz: 438.5, channel: 'a' }]);
  });

  it('有一个写坏了就整张不收，不悄悄丢掉那一个', () => {
    const r = readAnalogChannels({ channels: [{ freqMhz: 438.5, channel: 'a' }, { freqMhz: 438.975 }] });
    expect(r.channels).toBeUndefined();
    expect(r.problems).toEqual(['analog.channels[1].channel 必填']);
  });

  it('不在 2m 或 70cm 的不收，哪怕一支接收机收得下', () => {
    const r = readAnalogChannels({ channels: [{ freqMhz: 100, channel: 'a' }, { freqMhz: 100.5, channel: 'b' }] });
    expect(r.problems.length).toBe(2);
    expect(r.problems[0]).toMatch(/2m 或 70cm/);
  });

  it('重名、收不下、一个都没有，都说清楚', () => {
    expect(
      readAnalogChannels({ channels: [{ freqMhz: 438.5, channel: 'a' }, { freqMhz: 438.975, channel: 'a' }] }).problems,
    ).toEqual(['analog.channels 的信道名不能重复']);
    expect(
      readAnalogChannels({ channels: [{ freqMhz: 438.0, channel: 'a' }, { freqMhz: 440.0, channel: 'b' }] }).problems[0],
    ).toMatch(/最多 1.8 MHz/);
    expect(readAnalogChannels({}).problems).toEqual(['analog.channels 至少要有一个信道']);
    expect(readAnalogChannels({ channels: [] }).problems).toEqual(['analog.channels 至少要有一个信道']);
  });
});

describe('readAnalogChannels：模拟守听关着时', () => {
  it('没有信道表不算错', () => {
    expect(readAnalogChannels({}, false)).toEqual({ channels: [], problems: [] });
    expect(readAnalogChannels({ channels: [] }, false)).toEqual({ channels: [], problems: [] });
  });

  it('有信道表还是照样全验一遍', () => {
    const r = readAnalogChannels({ channels: [{ freqMhz: 100, channel: 'a' }] }, false);
    expect(r.channels).toBeUndefined();
    expect(r.problems[0]).toMatch(/2m 或 70cm/);
  });
});
