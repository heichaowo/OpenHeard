import { describe, expect, it } from 'vitest';
import {
  clusterOfGroup,
  extendChannel,
  finalConversations,
  groupByQso,
  mergeWindows,
  toConversation,
  touchesWindowEnd,
  touchesWindowStart,
  unresolvedStatus,
} from './conversation.ts';
import type { Activity, Cluster } from './types.ts';

const at = (id: string, startAt: number, durationS = 5, over: Partial<Activity> = {}): Activity => ({
  id,
  origin: 'sdr-fm',
  startAt,
  durationS,
  mine: false,
  ...over,
});

describe('unresolvedStatus', () => {
  const win = 3 * 86400;

  it('没有本台成员是旁听', () => {
    expect(unresolvedStatus([at('a', 100, 5, { mine: false })], 1000, win)).toBe('overheard');
  });

  it('本台成员在窗口内是待确认', () => {
    const now = 1_000_000;
    expect(unresolvedStatus([at('a', now - 10, 5, { mine: true })], now, win)).toBe('pending');
  });

  it('本台成员出了窗口是未入库', () => {
    const now = 1_000_000;
    expect(unresolvedStatus([at('a', now - win - 10, 5, { mine: true })], now, win)).toBe('unlogged');
  });

  it('边界严格大于：正好等于窗口边界算出了窗口', () => {
    const now = 1_000_000;
    expect(unresolvedStatus([at('a', now - win, 5, { mine: true })], now, win)).toBe('unlogged');
  });

  it('本台和非本台混着，只要有一个本台在窗口内就是待确认', () => {
    const now = 1_000_000;
    const members = [
      at('a', now - win - 10, 5, { mine: true }),
      at('b', now - 5, 5, { mine: true }),
      at('c', now - 3, 5, { mine: false }),
    ];
    expect(unresolvedStatus(members, now, win)).toBe('pending');
  });
});

describe('clusterOfGroup', () => {
  it('按时间升序，不做间隔切分', () => {
    const c = clusterOfGroup([at('b', 200, 5), at('a', 100, 60)]);
    expect(c.activities.map((a) => a.id)).toEqual(['a', 'b']);
    expect(c.id).toBe('a');
    expect(c.startAt).toBe(100);
    expect(c.endAt).toBe(205);
  });

  it('重叠成员的 endAt 取最晚的那个', () => {
    const c = clusterOfGroup([at('a', 100, 5), at('b', 102, 60)]);
    expect(c.endAt).toBe(162);
  });
});

describe('groupByQso', () => {
  it('按 qso_id 分组', () => {
    const g = groupByQso([
      { activity: at('a', 100), qsoId: 'q1' },
      { activity: at('b', 200), qsoId: 'q2' },
      { activity: at('c', 300), qsoId: 'q1' },
    ]);
    expect([...g.keys()].sort()).toEqual(['q1', 'q2']);
    expect(g.get('q1')!.map((a) => a.id)).toEqual(['a', 'c']);
  });
});

describe('toConversation', () => {
  const cluster: Cluster = {
    id: 'a',
    startAt: 100,
    endAt: 110,
    activities: [
      at('a', 100, 5, { mine: true, dmrId: 999, talkgroup: 46001, origin: 'brandmeister' }),
      at('b', 105, 5, { callsign: 'BD7KLO', dmrId: 777, talkgroup: 46001, origin: 'brandmeister' }),
    ],
  };

  it('没结算的三档带草稿', () => {
    for (const status of ['pending', 'unlogged', 'overheard'] as const) {
      const conv = toConversation(cluster, status);
      expect(conv.draft).toBeDefined();
      expect(conv.draft?.call).toBe('BD7KLO');
    }
  });

  it('已入库和已忽略不带草稿', () => {
    expect(toConversation(cluster, 'logged').draft).toBeUndefined();
    expect(toConversation(cluster, 'ignored').draft).toBeUndefined();
  });

  it('channel 和 origin 取第一个成员的', () => {
    const conv = toConversation(cluster, 'pending');
    expect(conv.channel).toBe('tg:46001');
    expect(conv.origin).toBe('brandmeister');
  });

  it('id、startAt、endAt 原样带过来', () => {
    const conv = toConversation(cluster, 'pending');
    expect(conv.id).toBe('a');
    expect(conv.startAt).toBe(100);
    expect(conv.endAt).toBe(110);
  });

  it('已入库时带上 qso 字段', () => {
    const conv = toConversation(cluster, 'logged', { qso: { id: 'q1', call: 'BD7KLO', rstSent: '59', rstRcvd: '59' } });
    expect(conv.qso).toEqual({ id: 'q1', call: 'BD7KLO', rstSent: '59', rstRcvd: '59' });
  });
});

describe('mergeWindows', () => {
  it('空种子返回空', () => {
    expect(mergeWindows([], 7200)).toEqual([]);
  });

  it('不重叠的种子各自一个窗口', () => {
    expect(mergeWindows([100, 100_000], 7200)).toEqual([
      { start: -7100, end: 7300 },
      { start: 92800, end: 107200 },
    ]);
  });

  it('窗口重叠时合并成一个', () => {
    // 两颗种子相距 10000 秒，半宽 7200，窗口有重叠
    expect(mergeWindows([100, 10100], 7200)).toEqual([{ start: -7100, end: 17300 }]);
  });

  it('乱序输入也能正确合并', () => {
    expect(mergeWindows([10100, 100], 7200)).toEqual([{ start: -7100, end: 17300 }]);
  });

  it('三颗种子链式重叠合并成一个', () => {
    expect(mergeWindows([0, 10000, 20000], 7200)).toEqual([{ start: -7200, end: 27200 }]);
  });
});

describe('touchesWindowStart / touchesWindowEnd', () => {
  it('首行紧贴窗口起点算碰到', () => {
    expect(touchesWindowStart(1000, 900, 120)).toBe(true);
    expect(touchesWindowStart(1121, 900, 120)).toBe(false);
  });

  it('末行紧贴窗口终点算碰到', () => {
    expect(touchesWindowEnd(1000, 1100, 120)).toBe(true);
    expect(touchesWindowEnd(950, 1100, 120)).toBe(false);
  });
});

describe('extendChannel', () => {
  const gap = 120;

  it('不碰边界时不扩窗，也不调用 readMore', () => {
    let called = false;
    const clusters = extendChannel([at('a', 1000, 5)], 0, 2000, gap, () => {
      called = true;
      return [];
    });
    expect(clusters).toHaveLength(1);
    expect(called).toBe(false);
  });

  it('碰到起点就往前扩一步，读到真正的停顿为止', () => {
    // 窗口 [1000, 3000)。a 紧贴窗口起点，说明它可能是更早那段对话的尾巴。
    // 往前扩一步读到 b：离新窗口起点足够远（>120 秒），到此为止。
    const newLo = 1000 - 7200;
    const clusters = extendChannel([at('a', 1000, 5)], 1000, 3000, gap, (from, to) => {
      expect(from).toBe(newLo);
      expect(to).toBe(1000);
      return [at('b', newLo + 1000, 5)];
    });
    expect(clusters.map((c) => c.activities.map((a) => a.id))).toEqual([['b'], ['a']]);
  });

  it('往前扩之后新的首行还碰边界，继续扩，直到不再碰为止', () => {
    let calls = 0;
    const firstLo = 1000 - 7200;
    const clusters = extendChannel([at('a', 1000, 5)], 1000, 3000, gap, (from, to) => {
      calls += 1;
      if (calls === 1) {
        // 第一次扩：读到的 b 紧贴新窗口起点，逼着再扩一次
        expect(from).toBe(firstLo);
        return [at('b', firstLo + 50, 5)];
      }
      // 第二次扩：c 离窗口起点足够远，真正的停顿
      const secondLo = firstLo - 7200;
      expect(from).toBe(secondLo);
      return [at('c', secondLo + 1000, 5)];
    });
    expect(calls).toBe(2);
    // b 和 a 之间、c 和 b 之间都隔了几千秒，各自一段
    expect(clusters.map((c) => c.activities.map((a) => a.id))).toEqual([['c'], ['b'], ['a']]);
  });

  it('两头都碰边界时各自扩一步', () => {
    const seen: { from: number; to: number }[] = [];
    const clusters = extendChannel([at('a', 1000, 5)], 1000, 1010, gap, (from, to) => {
      seen.push({ from, to });
      return [];
    });
    expect(seen).toHaveLength(2);
    expect(clusters).toHaveLength(1);
  });

  it('空输入返回空，不调用 readMore', () => {
    expect(extendChannel([], 0, 100, gap, () => [at('x', 50)])).toEqual([]);
  });
});

describe('finalConversations', () => {
  const c = (id: string, startAt: number): Cluster => ({ id, startAt, endAt: startAt + 5, activities: [at(id, startAt)] });

  it('没有更多种子时全部定型', () => {
    const clusters = [c('a', 100), c('b', 50)];
    expect(finalConversations(clusters, undefined)).toEqual(clusters);
  });

  it('只保留 startAt 不早于下一个未读种子的那些', () => {
    const clusters = [c('a', 100), c('b', 50), c('c', 30)];
    expect(finalConversations(clusters, 50).map((x) => x.id)).toEqual(['a', 'b']);
  });
});
