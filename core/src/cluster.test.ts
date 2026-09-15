import { describe, expect, it } from 'vitest';
import { clusterActivities } from './cluster.ts';
import type { Activity } from './types.ts';

const at = (id: string, startAt: number, durationS = 5, over: Partial<Activity> = {}): Activity => ({
  id,
  origin: 'sdr-fm',
  startAt,
  durationS,
  mine: false,
  ...over,
});

const shape = (activities: Activity[], gap: number) =>
  clusterActivities(activities, gap).map((c) => c.activities.map((a) => a.id));

describe('clusterActivities', () => {
  it('空输入返回空', () => {
    expect(clusterActivities([], 30)).toEqual([]);
  });

  it('一条就是一段', () => {
    const c = clusterActivities([at('a', 100, 5)], 30);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ id: 'a', startAt: 100, endAt: 105 });
  });

  it('间隔量的是静默，不是起点到起点', () => {
    // 第一条从 100 发到 160，第二条 170 开始。静默 10 秒，起点差 70 秒。
    expect(shape([at('a', 100, 60), at('b', 170, 5)], 30)).toEqual([['a', 'b']]);
  });

  it('间隔正好等于阈值时合并', () => {
    expect(shape([at('a', 100, 5), at('b', 135, 5)], 30)).toEqual([['a', 'b']]);
  });

  it('间隔超过阈值时切开', () => {
    expect(shape([at('a', 100, 5), at('b', 136, 5)], 30)).toEqual([['a'], ['b']]);
  });

  it('输入乱序时结果和排好序一样', () => {
    const rows = [at('c', 300), at('a', 100), at('b', 120)];
    expect(shape(rows, 30)).toEqual([['a', 'b'], ['c']]);
  });

  it('不改动传进来的数组', () => {
    const rows = [at('c', 300), at('a', 100)];
    clusterActivities(rows, 30);
    expect(rows.map((r) => r.id)).toEqual(['c', 'a']);
  });

  it('同一时刻的两条按 id 定序，结果稳定', () => {
    expect(shape([at('b', 100), at('a', 100)], 30)).toEqual([['a', 'b']]);
    expect(clusterActivities([at('b', 100), at('a', 100)], 30)[0]!.id).toBe('a');
  });

  it('重叠的发射算同一段，endAt 取最靠后的结束时刻', () => {
    // b 被 a 整个包住，段的结束时刻应当还是 a 的。
    const c = clusterActivities([at('a', 100, 60), at('b', 110, 5)], 1);
    expect(c).toHaveLength(1);
    expect(c[0]!.endAt).toBe(160);
  });

  it('长发射之后的下一条按它自己的结束时刻判定', () => {
    // a 结束于 160，b 从 170 开始并到 175 结束，c 从 200 开始。
    // 若拿 a 的结束时刻去判 c 就会切错，这里应当三条一段。
    expect(shape([at('a', 100, 60), at('b', 170, 5), at('c', 200, 5)], 30)).toEqual([
      ['a', 'b', 'c'],
    ]);
  });

  it('小数时长不丢精度', () => {
    const c = clusterActivities([at('a', 100, 3.2), at('b', 104, 1.5)], 1);
    expect(c).toHaveLength(1);
    expect(c[0]!.endAt).toBeCloseTo(105.5, 5);
  });
});
