import { describe, expect, it } from 'vitest';
import { isValidCallsign, normalizeCallsign, prefixRange } from './callsign.ts';

describe('normalizeCallsign', () => {
  it('去空格并转大写', () => {
    expect(normalizeCallsign(' bd 7 klo ')).toBe('BD7KLO');
    expect(normalizeCallsign('bg0cg/p')).toBe('BG0CG/P');
  });
});

describe('isValidCallsign', () => {
  it('接受常见形式', () => {
    expect(isValidCallsign('BG0CG')).toBe(true);
    expect(isValidCallsign('bd7klo')).toBe(true);
    expect(isValidCallsign('BG0CG/P')).toBe(true);
    expect(isValidCallsign('VP2E/BG0CG')).toBe(true);
  });

  it('挡住明显打错的', () => {
    expect(isValidCallsign('')).toBe(false);
    expect(isValidCallsign('AB')).toBe(false);
    expect(isValidCallsign('BG0CG!')).toBe(false);
    expect(isValidCallsign('ABCDE')).toBe(false);
    expect(isValidCallsign('12345')).toBe(false);
    expect(isValidCallsign('BG0CG//P')).toBe(false);
  });
});

describe('prefixRange', () => {
  it('给出半开区间，边界在最后一个字符上加一', () => {
    expect(prefixRange('BG')).toEqual(['BG', 'BH']);
    expect(prefixRange('BG0CG')).toEqual(['BG0CG', 'BG0CH']);
  });

  it('范围能框住所有以这个前缀开头的字符串，也框不住别的', () => {
    const [lo, hi] = prefixRange('BG0');
    for (const s of ['BG0', 'BG0CG', 'BG0ZZZ']) {
      expect(s >= lo && s < hi).toBe(true);
    }
    for (const s of ['BF9', 'BG1', 'BH0']) {
      expect(s >= lo && s < hi).toBe(false);
    }
  });
});
