import { describe, expect, it } from 'vitest';
import { draftFromCluster, missingFields } from './draft';
import type { Activity, Cluster } from './types';

const at = (over: Partial<Activity>): Activity => ({
  id: 'a',
  origin: 'sdr-fm',
  startAt: 1_789_000_000,
  durationS: 5,
  mine: false,
  ...over,
});

const cluster = (activities: Activity[]): Cluster => ({
  id: 'c1',
  startAt: activities[0]!.startAt,
  endAt: activities[activities.length - 1]!.startAt + 5,
  activities,
});

describe('draftFromCluster', () => {
  it('模拟侧填不出呼号，所以只缺 call', () => {
    const d = draftFromCluster(
      cluster([at({ id: 'a1', mine: false, freqMhz: 439.525 }), at({ id: 'a2', mine: true, freqMhz: 439.525 })]),
    );
    expect(d.call).toBeUndefined();
    expect(d.mode).toBe('FM');
    expect(d.band).toBe('70cm');
    expect(missingFields(d)).toEqual(['call']);
  });

  it('取对方的呼号，不取自己的', () => {
    const d = draftFromCluster(
      cluster([
        at({ id: 'a1', origin: 'brandmeister', mine: true, callsign: 'BG0CG' }),
        at({ id: 'a2', origin: 'brandmeister', mine: false, callsign: 'BD7KLO' }),
      ]),
      { networkFreqMhz: 439.525 },
    );
    expect(d.call).toBe('BD7KLO');
    expect(d.mode).toBe('DMR');
    expect(missingFields(d)).toEqual([]);
  });

  it('网络会话没有射频频率，用配置里的记账频率', () => {
    const d = draftFromCluster(cluster([at({ origin: 'brandmeister', mine: true })]), {
      networkFreqMhz: 439.525,
    });
    expect(d.freqMhz).toBe(439.525);
    expect(d.band).toBe('70cm');
  });

  it('没有频率就连波段也给不出', () => {
    const d = draftFromCluster(cluster([at({ origin: 'brandmeister', mine: true })]));
    expect(d.freqMhz).toBeUndefined();
    expect(d.band).toBeUndefined();
    expect(missingFields(d)).toEqual(['call', 'freqMhz', 'band']);
  });

  it('本台信息来自配置，对方信息不预填', () => {
    const d = draftFromCluster(cluster([at({ freqMhz: 145.5 })]), {
      myGridsquare: 'OM24',
      myQth: '成都',
      myPower: '5W',
    });
    expect(d.myGridsquare).toBe('OM24');
    expect(d.myQth).toBe('成都');
    expect(d.gridsquare).toBeUndefined();
    expect(d.qth).toBeUndefined();
  });
});
