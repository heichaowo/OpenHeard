import { describe, expect, it } from 'vitest';
import { aiFill, aiMapOf, applyAiFill, isMeaninglessConversation } from './ai.ts';
import { toConversation } from './conversation.ts';
import { draftFromCluster, draftWithAi } from './draft.ts';
import type { Activity, ActivityAi, Cluster, HeardItem } from './types.ts';

const T = 1_789_000_000;
const fm = (id: string, i: number, mine: boolean, ai?: Partial<ActivityAi>): HeardItem => ({
  id,
  origin: 'sdr-fm',
  startAt: T + i * 30,
  durationS: 5,
  mine,
  freqMhz: 438.975,
  channel: '438.975 直频',
  ...(ai === undefined ? {} : { ai: { meaningless: false, ...ai } }),
});

const cluster = (acts: Activity[]): Cluster => ({
  id: acts[0]!.id,
  startAt: acts[0]!.startAt,
  endAt: acts.at(-1)!.startAt + 5,
  activities: acts,
});

const MY = 'BG0CG';

describe('aiFill', () => {
  it('对方说的 call 和本台叫的 calledCall 合起来数，本台自己的呼号剔掉', () => {
    const m = [
      fm('a', 0, true, { fields: { call: 'BG0CG', calledCall: 'BD7ABC' } }),
      fm('b', 1, false, { fields: { call: 'BD7ABC', calledCall: 'BG0CG' } }),
    ];
    const r = aiFill(m, aiMapOf(m), MY);
    expect(r.fields.call).toBe('BD7ABC');
    expect(r.filled).toEqual(['call']);
  });

  it('本台自己的呼号被说成对方的呼号时不能当对方', () => {
    const m = [fm('a', 0, false, { fields: { call: 'bg0cg' } })];
    expect(aiFill(m, aiMapOf(m), MY).fields.call).toBeUndefined();
  });

  it('一样多取更晚那次发射的呼号', () => {
    const m = [
      fm('a', 0, false, { fields: { call: 'BD7AAA' } }),
      fm('b', 1, false, { fields: { call: 'BD7BBB' } }),
    ];
    expect(aiFill(m, aiMapOf(m), MY).fields.call).toBe('BD7BBB');
  });

  it('出现次数多的赢，不管早晚', () => {
    const m = [
      fm('a', 0, false, { fields: { call: 'BD7AAA' } }),
      fm('b', 1, false, { fields: { call: 'BD7AAA' } }),
      fm('c', 2, false, { fields: { call: 'BD7BBB' } }),
    ];
    expect(aiFill(m, aiMapOf(m), MY).fields.call).toBe('BD7AAA');
  });

  it('不像呼号的丢掉', () => {
    const m = [fm('a', 0, false, { fields: { call: '你好' } })];
    expect(aiFill(m, aiMapOf(m), MY).fields.call).toBeUndefined();
  });

  it('QTH 和对方的报告取对方最新的，本台的报告是发出去的', () => {
    const m = [
      fm('a', 0, false, { fields: { qth: '海淀', rst: '57' } }),
      fm('b', 1, true, { fields: { rst: '59', qth: '本台的 QTH 不取' } }),
      fm('c', 2, false, { fields: { qth: '朝阳' } }),
    ];
    const r = aiFill(m, aiMapOf(m), MY);
    expect(r.fields).toMatchObject({ qth: '朝阳', rstRcvd: '57', rstSent: '59' });
    expect(r.filled).toEqual(['qth', 'rstRcvd', 'rstSent']);
  });

  it('备注只写说了的那几样，各取对方最新的', () => {
    const m = [
      fm('a', 0, false, { fields: { device: 'UV-5R', power: '4W' } }),
      fm('b', 1, false, { fields: { antenna: '原装', power: '5W' } }),
    ];
    expect(aiFill(m, aiMapOf(m), MY).fields.note).toBe('对方设备 UV-5R，天线 原装，功率 5W');
    const n = [fm('a', 0, false, { fields: { height: '30米' } })];
    expect(aiFill(n, aiMapOf(n), MY).fields.note).toBe('高度 30米');
  });

  it('没有识别结果就什么都不填', () => {
    const m = [fm('a', 0, false)];
    expect(aiFill(m, aiMapOf(m), MY)).toEqual({ fields: {}, filled: [] });
  });
});

describe('applyAiFill', () => {
  const fill = { fields: { call: 'BD7ABC', qth: '海淀', rstRcvd: '57', note: '备注' }, filled: ['call', 'qth', 'rstRcvd', 'note'] as const };

  it('只填留空或者还是缺省 59 的字段', () => {
    const r = applyAiFill({ call: 'BA1XX', qth: undefined, rstRcvd: '59', note: '人写的' }, { ...fill, filled: [...fill.filled] });
    expect(r.draft).toMatchObject({ call: 'BA1XX', qth: '海淀', rstRcvd: '57', note: '人写的' });
    expect(r.filled).toEqual(['qth', 'rstRcvd']);
  });

  it('报告人改过就不动', () => {
    const r = applyAiFill({ rstRcvd: '55' }, { fields: { rstRcvd: '57' }, filled: ['rstRcvd'] });
    expect(r.draft.rstRcvd).toBe('55');
    expect(r.filled).toEqual([]);
  });
});

describe('draftFromCluster 用 AI 的结果', () => {
  const defaults = { myCallsign: MY, networkFreqMhz: 439.525 };

  it('呼号取不到时用 AI 的，其余字段进草稿', () => {
    const c = cluster([
      fm('a', 0, true, { fields: { calledCall: 'BD7ABC', rst: '59' } }),
      fm('b', 1, false, { fields: { call: 'BD7ABC', qth: '海淀', rst: '57', device: 'UV-5R' } }),
    ]);
    const { draft, aiFilled } = draftWithAi(c, defaults);
    expect(draft).toMatchObject({ call: 'BD7ABC', qth: '海淀', rstRcvd: '57', rstSent: '59', note: '对方设备 UV-5R' });
    expect(aiFilled).toEqual(['call', 'qth', 'rstRcvd', 'rstSent', 'note']);
    expect(draftFromCluster(c, defaults)).toEqual(draft);
  });

  it('活动行自带的呼号优先，AI 不覆盖', () => {
    const c = cluster([
      { ...fm('a', 0, false, { fields: { call: 'BD7ABC' } }), callsign: 'BA1REAL' },
    ]);
    const { draft, aiFilled } = draftWithAi(c, defaults);
    expect(draft.call).toBe('BA1REAL');
    expect(aiFilled).not.toContain('call');
  });

  it('没有识别结果时和以前完全一样，也没有 aiFilled', () => {
    const c = cluster([fm('a', 0, false)]);
    const conv = toConversation(c, 'overheard', { defaults });
    expect(conv.aiFilled).toBeUndefined();
    expect(conv.draft?.qth).toBeUndefined();
    expect(conv.draft?.note).toBeUndefined();
  });
});

describe('isMeaninglessConversation', () => {
  const dead = { meaningless: true };
  it('每次发射都无意义才算', () => {
    expect(isMeaninglessConversation('unlogged', [fm('a', 0, true, dead), fm('b', 1, false, dead)])).toBe(true);
    expect(isMeaninglessConversation('unlogged', [fm('a', 0, true, dead), fm('b', 1, false, { meaningless: false })])).toBe(false);
  });

  it('没有识别结果的成员让它不算无意义', () => {
    expect(isMeaninglessConversation('unlogged', [fm('a', 0, true, dead), fm('b', 1, false)])).toBe(false);
    const digital: HeardItem = { id: 'd', origin: 'brandmeister', startAt: T, durationS: 3, mine: true };
    expect(isMeaninglessConversation('pending', [digital])).toBe(false);
  });

  it('已入库的永远不算，已忽略的照算', () => {
    expect(isMeaninglessConversation('logged', [fm('a', 0, true, dead)])).toBe(false);
    expect(isMeaninglessConversation('ignored', [fm('a', 0, true, dead)])).toBe(true);
  });

  it('toConversation 带上 meaningless', () => {
    const c = cluster([fm('a', 0, true, dead)]);
    expect(toConversation(c, 'pending').meaningless).toBe(true);
    expect(toConversation(c, 'logged', { qso: { id: 'q', call: 'X', rstSent: '59', rstRcvd: '59' } }).meaningless).toBe(false);
  });
});
