import { describe, expect, it } from 'vitest';
import { callFor, knownCalls } from './known-calls.ts';
import { draftFromCluster } from './draft.ts';
import type { Activity, Cluster } from './types.ts';

const act = (id: string, over: Partial<Activity> = {}): Activity => ({
  id,
  origin: 'brandmeister',
  startAt: 1_789_000_000,
  durationS: 5,
  mine: false,
  ...over,
});

describe('knownCalls', () => {
  it('记住每个 DMR ID 见过的呼号', () => {
    const known = knownCalls([
      act('a', { dmrId: 4616472, callsign: 'BH7IBG' }),
      act('b', { dmrId: 4606502, callsign: 'BH8FUW' }),
    ]);
    expect(callFor(known, 4616472)).toBe('BH7IBG');
    expect(callFor(known, 4606502)).toBe('BH8FUW');
    expect(callFor(known, 999)).toBeUndefined();
    expect(callFor(known, undefined)).toBeUndefined();
  });

  it('没有呼号或没有 ID 的行不进表', () => {
    const known = knownCalls([act('a', { dmrId: 1 }), act('b', { callsign: 'BA1AA' })]);
    expect(known.size).toBe(0);
  });

  it('同一个 ID 以后来的为准，人会换呼号', () => {
    const known = knownCalls([
      act('a', { dmrId: 1, callsign: 'BG0AAA' }),
      act('b', { dmrId: 1, callsign: 'BG0BBB' }),
    ]);
    expect(callFor(known, 1)).toBe('BG0BBB');
  });
});

describe('draftFromCluster 用对照表补呼号', () => {
  const cluster = (activities: Activity[]): Cluster => ({
    id: 'c1',
    startAt: activities[0].startAt,
    endAt: activities[activities.length - 1].startAt + 5,
    activities,
  });

  // BrandMeister 不是每条都带 SourceCall。缺的那几条，以前见过这个 ID
  // 的呼号就该补上，而不是让人为一个早就见过的 ID 再打一遍。
  it('这一段没带呼号，但这个 ID 以前见过', () => {
    const known = knownCalls([act('old', { dmrId: 4616472, callsign: 'BH7IBG' })]);
    const c = cluster([
      act('m', { mine: true, dmrId: 4616460, talkgroup: 46001 }),
      act('x', { dmrId: 4616472, talkgroup: 46001 }),
    ]);

    expect(draftFromCluster(c, {}, known).call).toBe('BH7IBG');
    // 不给表就还是空的
    expect(draftFromCluster(c, {}).call).toBeUndefined();
  });

  it('这一段自己带了呼号就用它，不看表', () => {
    const known = knownCalls([act('old', { dmrId: 4616472, callsign: '旧的' })]);
    const c = cluster([act('x', { dmrId: 4616472, callsign: 'BH7IBG' })]);
    expect(draftFromCluster(c, {}, known).call).toBe('BH7IBG');
  });

  it('本台自己那几条不拿来当对方呼号', () => {
    const known = knownCalls([act('old', { dmrId: 4616460, callsign: 'BG0CG' })]);
    const c = cluster([act('m', { mine: true, dmrId: 4616460 })]);
    expect(draftFromCluster(c, {}, known).call).toBeUndefined();
  });
});
