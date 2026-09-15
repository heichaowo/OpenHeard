import { describe, expect, it } from 'vitest';
import { recallStation } from './recall.ts';
import type { Qso } from './types.ts';

const qso = (call: string, startAt: number, over: Partial<Qso> = {}): Qso => ({
  id: `${call}-${startAt}`,
  call,
  startAt,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'FM',
  rstSent: '59',
  rstRcvd: '59',
  createdAt: startAt,
  ...over,
});

describe('recallStation', () => {
  it('没记录就没有', () => {
    expect(recallStation([], 'BD7KLO')).toBeUndefined();
  });

  it('取上次记下的 QTH 和网格', () => {
    const log = [qso('BD7KLO', 100, { qth: '深圳', gridsquare: 'OL72' })];
    expect(recallStation(log, 'bd7klo')).toEqual({
      qth: '深圳',
      gridsquare: 'OL72',
      lastAt: 100,
    });
  });

  // 人会搬家。旧的那条不该盖住新的，所以只取最近一条，不合并。
  it('只取最近一条，不把旧地址并进来', () => {
    const log = [
      qso('BD7KLO', 100, { qth: '深圳', gridsquare: 'OL72' }),
      qso('BD7KLO', 200, { qth: '广州' }),
    ];
    expect(recallStation(log, 'BD7KLO')).toEqual({
      qth: '广州',
      gridsquare: undefined,
      lastAt: 200,
    });
  });

  it('跳过两样都没有的记录', () => {
    const log = [qso('BD7KLO', 100, { qth: '深圳' }), qso('BD7KLO', 300)];
    expect(recallStation(log, 'BD7KLO')?.lastAt).toBe(100);
  });

  it('认不出别人的呼号', () => {
    const log = [qso('BD7KLO', 100, { qth: '深圳' })];
    expect(recallStation(log, 'BA1AA')).toBeUndefined();
    expect(recallStation(log, '')).toBeUndefined();
  });
});
