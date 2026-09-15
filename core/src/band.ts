import type { Mode, Origin } from './types.ts';

/**
 * 频率转 ADIF 波段名。
 * 只列本台现在能用的两个波段。考出 B 证上短波时在这里加。
 */
export function bandOf(freqMhz: number): string | undefined {
  if (freqMhz >= 144 && freqMhz <= 148) return '2m';
  if (freqMhz >= 420 && freqMhz <= 450) return '70cm';
  return undefined;
}

/** 采集来源决定模式。模拟接收机只解 FM，另外两个来源都是 DMR。 */
export function modeOf(origin: Origin): Mode {
  return origin === 'sdr-fm' ? 'FM' : 'DMR';
}
