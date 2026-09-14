import { describe, expect, it } from 'vitest';
import { isValidCallsign, normalizeCallsign } from './callsign';

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
