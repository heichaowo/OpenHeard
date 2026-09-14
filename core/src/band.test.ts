import { describe, expect, it } from 'vitest';
import { bandOf, modeOf } from './band';

describe('bandOf', () => {
  it('两个波段的边界都算在内', () => {
    expect(bandOf(144)).toBe('2m');
    expect(bandOf(148)).toBe('2m');
    expect(bandOf(145.5)).toBe('2m');
    expect(bandOf(420)).toBe('70cm');
    expect(bandOf(450)).toBe('70cm');
    expect(bandOf(439.525)).toBe('70cm');
  });

  it('波段外返回 undefined', () => {
    expect(bandOf(143.9)).toBeUndefined();
    expect(bandOf(14.2)).toBeUndefined();
    expect(bandOf(1240)).toBeUndefined();
  });
});

describe('modeOf', () => {
  it('只有模拟接收机产生 FM', () => {
    expect(modeOf('sdr-fm')).toBe('FM');
    expect(modeOf('sdr-dmr')).toBe('DMR');
    expect(modeOf('brandmeister')).toBe('DMR');
  });
});
