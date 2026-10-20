import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Config } from './config.ts';
import type { Activity } from './core.ts';
import { setVerdicts, writeAiResults } from './ai.ts';
import {
  dayConversations,
  meaninglessConversations,
  pendingConversations,
  searchConversations,
  unloggedConversations,
} from './conversations.ts';
import { insertActivities, insertQso, openDb, resolveActivities } from './db.ts';

const MY_ID = 4616460;

const config: Config = {
  dbPath: ':memory:',
  path: '/tmp/openheard-conversations-test.config.json',
  host: '127.0.0.1',
  adminPasswordHash: 'scrypt$x',
  sessionSecret: 's'.repeat(40),
  dmrId: MY_ID,
  clusterGapS: 120,
  pendingWindowDays: 3,
  activityRetentionDays: 90,
  ingestToken: 'x'.repeat(32),
  station: {},
  channels: [],
  queries: [],
  brandmeisterEnabled: true,
  recordingsDir: '/tmp/openheard-conversations-test-recordings',
};

const act = (id: string, startAt: number, over: Partial<Activity> = {}): Activity => ({
  id,
  origin: 'brandmeister',
  startAt,
  durationS: 5,
  mine: false,
  talkgroup: 46001,
  ...over,
});

const fresh = () => openDb(':memory:');
const ins = (db: ReturnType<typeof fresh>, rows: Activity[]) =>
  insertActivities(db, rows.map((a) => ({ activity: a, raw: '{}' })), 1);

// 涉及「待确认窗口」「保留期」这类相对当下的判断时，时刻要落在真实的
// 「现在」附近，不能用从 0 起算的小数字——那样会被直接卡在窗口或保留期外。
const NOW = Math.floor(Date.now() / 1000);

describe('dayConversations', () => {
  it('只给这一天里开始的对话，前后两小时只是用来聚类', () => {
    const db = fresh();
    // from=10_000, to=20_000：这条从 9990 开始，进了缓冲区但没进这一天
    ins(db, [act('early', 9990, { dmrId: MY_ID })]);
    ins(db, [act('inday', 15_000, { dmrId: MY_ID })]);
    const page = dayConversations(db, config, 10_000, 20_000, {});
    assert.deepEqual(
      page.items.map((c) => c.id),
      ['inday'],
    );
  });

  it('一段对话碰到窗口边界，顺着信道往外接，天视图和跨天视图给出同一个 id', () => {
    const db = fresh();
    // 一条长对话：0 -> 8000 -> 16050 -> 21100，横跨两小时缓冲区边界。
    ins(db, [
      act('a', 0, { dmrId: MY_ID, durationS: 8000 }),
      act('b', 8050, { durationS: 8000 }),
      act('c', 16_100, { durationS: 5000 }),
    ]);
    // 当天窗口只到 7200（from=0,to=7200，缓冲区到 14400），第一天视图应当
    // 顺着链条接到 c，startAt 还是 0。
    const day1 = dayConversations(db, config, 0, 7200, {});
    assert.equal(day1.items.length, 1);
    assert.equal(day1.items[0]!.id, 'a');
    assert.equal(day1.items[0]!.endAt, 21_100);
    assert.deepEqual(
      day1.items[0]!.activities.map((a) => a.id),
      ['a', 'b', 'c'],
    );
  });

  it('未结算、已忽略、已入库不会因为挨得近而并成一段', () => {
    const db = fresh();
    const t = NOW - 1000; // 在待确认窗口内，未结算的那条才算 pending
    ins(db, [
      act('u', t, { dmrId: MY_ID }), // 未结算
      act('i', t + 10, { dmrId: MY_ID }), // 忽略
      act('l', t + 20, { dmrId: MY_ID }), // 入库
    ]);
    resolveActivities(db, ['i'], null, t);
    insertQso(db, {
      id: 'q1',
      call: 'BD7KLO',
      startAt: t + 20,
      freqMhz: 439.525,
      band: '70cm',
      mode: 'DMR',
      rstSent: '59',
      rstRcvd: '59',
      createdAt: t,
    });
    resolveActivities(db, ['l'], 'q1', t);

    const page = dayConversations(db, config, t - 10, t + 100, {});
    const byId = new Map(page.items.map((c) => [c.id, c]));
    assert.equal(byId.get('u')?.status, 'pending');
    assert.equal(byId.get('i')?.status, 'ignored');
    assert.equal(byId.get('l')?.status, 'logged');
    assert.equal(byId.get('l')?.qso?.call, 'BD7KLO');
    assert.equal(page.items.length, 3);
  });

  it('channels 字段是这一天这个来源里出现过的信道，按 channel 过滤之前算', () => {
    const db = fresh();
    const t = 200_000;
    ins(db, [act('a', t, { dmrId: MY_ID, talkgroup: 46001 }), act('b', t + 10, { dmrId: MY_ID, talkgroup: 91 })]);
    const page = dayConversations(db, config, t - 10, t + 100, { channel: 'tg:46001' });
    assert.deepEqual(
      page.channels.map((c) => c.key).sort(),
      ['tg:46001', 'tg:91'],
    );
    assert.deepEqual(
      page.items.map((c) => c.id),
      ['a'],
    );
  });

  it('from/to 不对就报错', () => {
    assert.throws(() => dayConversations(fresh(), config, 100, 50, {}));
    assert.throws(() => dayConversations(fresh(), config, 0, 200_000, {}));
  });

  it('分页：keyset 游标，满一页多给一个 next', () => {
    const db = fresh();
    const t = 300_000;
    for (let i = 0; i < 3; i++) ins(db, [act(`c${i}`, t + i * 1000, { dmrId: MY_ID, talkgroup: 46001 + i })]);
    const page1 = dayConversations(db, config, t - 10, t + 5000, { limit: '2' });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.next);
    const page2 = dayConversations(db, config, t - 10, t + 5000, { limit: '2', cursor: page1.next });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.next, undefined);
  });
});

describe('pendingConversations', () => {
  const since = NOW - config.pendingWindowDays * 86400;

  // 以前待确认队列只读窗口内的行，窗口边上的开场白被截掉。按截掉之后的 id
  // 入库，开场白就成了一段永远不会进日志的旁听。
  it('一段对话跨过待确认窗口的起点，整段都在，id 和天视图一样', () => {
    const db = fresh();
    ins(db, [act('opener', since - 60), act('reply', since + 30, { dmrId: MY_ID })]);

    const pending = pendingConversations(db, config);
    assert.deepEqual(
      pending.map((c) => [c.id, c.activities.map((a) => a.id)]),
      [['opener', ['opener', 'reply']]],
    );
    const day = dayConversations(db, config, since - 3600, since + 3600, {});
    assert.equal(day.items[0]!.id, 'opener');
  });

  it('只有窗口外才有本台的对话不算待确认，没有本台的也不算', () => {
    const db = fresh();
    ins(db, [act('old-mine', since - 3600, { dmrId: MY_ID })]);
    ins(db, [act('heard', NOW - 600)]);
    assert.deepEqual(pendingConversations(db, config), []);
  });

  it('按开始时刻从早到晚排，和原来的队列一样', () => {
    const db = fresh();
    ins(db, [act('b', NOW - 600, { dmrId: MY_ID }), act('a', NOW - 7200, { dmrId: MY_ID, talkgroup: 460 })]);
    assert.deepEqual(pendingConversations(db, config).map((c) => c.id), ['a', 'b']);
  });
});

describe('unloggedConversations', () => {
  const pendingCutoff = () => Math.floor(Date.now() / 1000) - config.pendingWindowDays * 86400;

  it('出了待确认窗口、还没结算的本台对话才算未入库', () => {
    const db = fresh();
    const old = pendingCutoff() - 1000;
    ins(db, [act('u', old, { dmrId: MY_ID })]);
    const page = unloggedConversations(db, config, {});
    assert.deepEqual(
      page.items.map((c) => c.id),
      ['u'],
    );
    assert.equal(page.total, 1);
  });

  it('还在窗口内的不算未入库', () => {
    const db = fresh();
    const now = pendingCutoff() + 10_000;
    ins(db, [act('p', now, { dmrId: MY_ID })]);
    assert.deepEqual(unloggedConversations(db, config, {}).items, []);
  });

  it('没有本台成员的不算未入库（是旁听）', () => {
    const db = fresh();
    const old = pendingCutoff() - 1000;
    ins(db, [act('o', old, { mine: false, dmrId: 999 })]);
    assert.deepEqual(unloggedConversations(db, config, {}).items, []);
  });
});

describe('searchConversations', () => {
  // 保留期比待确认窗口短时，裁剪按窗口算，行还在库里，天视图看得到，搜索也要找得到。
  it('保留期比待确认窗口短时，按窗口算下限', () => {
    const db = fresh();
    const short = { ...config, pendingWindowDays: 10, activityRetentionDays: 5 };
    ins(db, [act('old', NOW - 7 * 86400, { callsign: 'BG0CG' })]);
    assert.deepEqual(searchConversations(db, short, 'BG0CG', {}).items.map((c) => c.id), ['old']);
  });

  it('前缀匹配，至少两个字符', () => {
    assert.throws(() => searchConversations(fresh(), config, 'B', {}));
  });

  it('按呼号前缀找到发射行，也找到日志里的呼号', () => {
    const db = fresh();
    const t = NOW - 500_000;
    ins(db, [act('a', t, { dmrId: MY_ID, callsign: undefined }), act('b', t + 5, { callsign: 'BD7KLO', dmrId: 1, talkgroup: 46001 })]);
    ins(db, [act('c', t + 100_000, { mine: false, callsign: undefined, dmrId: 2, talkgroup: 91 })]);
    insertQso(db, {
      id: 'q1',
      call: 'BD1XYZ',
      startAt: t + 100_000,
      freqMhz: 439.525,
      band: '70cm',
      mode: 'DMR',
      rstSent: '59',
      rstRcvd: '59',
      createdAt: t,
    });
    resolveActivities(db, ['c'], 'q1', t);

    const byCallsign = searchConversations(db, config, 'bd7', {});
    assert.deepEqual(byCallsign.items.map((c) => c.id).sort(), ['a']);

    const byLog = searchConversations(db, config, 'bd1', {});
    assert.deepEqual(byLog.items.map((c) => c.id).sort(), ['c']);
  });

  // 同一条长对话被两颗种子各自的窗口摸到，窗口本身不重叠（种子隔得够远），
  // 中间那条真正连起两边的发射谁的窗口都摸不到。必须去重成一条。
  it('长对话的两端各命中一次搜索，只回一条', () => {
    const db = fresh();
    const t = NOW - 100_000;
    ins(db, [
      act('a', t, { dmrId: MY_ID, durationS: 8000, callsign: 'BI3AH', talkgroup: 46001 }),
      act('bridge', t + 8050, { durationS: 8000, talkgroup: 46001 }),
      act('c', t + 16_100, { durationS: 5000, callsign: 'BI3AH', talkgroup: 46001 }),
    ]);
    const page = searchConversations(db, config, 'BI3AH', {});
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.id, 'a');
    assert.deepEqual(
      page.items[0]!.activities.map((a) => a.id),
      ['a', 'bridge', 'c'],
    );
  });

  it('不含种子、只是窗口合并顺带读到的邻近对话不返回', () => {
    const db = fresh();
    const t = NOW - 200_000;
    ins(db, [act('hit', t, { dmrId: MY_ID, callsign: 'BG0CG', talkgroup: 46001 })]);
    ins(db, [act('near', t + 1000, { dmrId: MY_ID, callsign: 'BD7KLO', talkgroup: 46001 })]);
    const page = searchConversations(db, config, 'BG0CG', {});
    assert.deepEqual(page.items.map((c) => c.id).sort(), ['hit']);
  });
});

// ---- AI 识别结果和无意义 ----------------------------------------------------

/** 模拟 FM 的一次发射。同一条信道，mine 是存下来的。 */
const fm = (id: string, startAt: number, over: Partial<Activity> = {}): Activity => ({
  id,
  origin: 'sdr-fm',
  startAt,
  durationS: 3,
  mine: false,
  freqMhz: 438.975,
  channel: '438.975 直频',
  ...over,
});

const noSpeech = (...ids: string[]) => ids.map((activityId) => ({ activityId, hasSpeech: false }));
const qsoOf = (id: string) => ({
  id,
  call: 'BD7KLO',
  startAt: NOW,
  freqMhz: 438.975,
  band: '70cm',
  mode: 'FM' as const,
  rstSent: '59',
  rstRcvd: '59',
  createdAt: NOW,
});

describe('识别结果进对话', () => {
  it('成员带上 ai，草稿用 AI 的呼号、QTH、报告和备注，aiFilled 说明哪几项', () => {
    const db = fresh();
    const t = NOW - 600;
    ins(db, [fm('a', t, { mine: true }), fm('b', t + 20)]);
    writeAiResults(
      db,
      [
        { activityId: 'a', hasSpeech: true, category: 'qso', fields: { call: 'BG0CG', calledCall: 'BD7ABC', rst: '59' } },
        { activityId: 'b', hasSpeech: true, category: 'qso', fields: { call: 'BD7ABC', qth: '海淀', rst: '57', device: 'UV-5R', power: '5W' } },
      ],
      NOW,
    );
    const c = dayConversations(db, { ...config, station: { myCallsign: 'BG0CG' } }, t - 100, t + 100, {}).items[0]!;
    assert.equal(c.activities[1]!.ai?.fields?.qth, '海淀');
    assert.equal(c.meaningless, false);
    assert.equal(c.draft?.call, 'BD7ABC');
    assert.equal(c.draft?.qth, '海淀');
    assert.equal(c.draft?.rstRcvd, '57');
    assert.equal(c.draft?.note, '对方设备 UV-5R，功率 5W');
    assert.deepEqual(c.aiFilled, ['call', 'qth', 'rstRcvd', 'rstSent', 'note']);
  });

  it('人工判定算进成员的 meaningless', () => {
    const db = fresh();
    const t = NOW - 600;
    ins(db, [fm('a', t, { mine: true })]);
    writeAiResults(db, noSpeech('a'), NOW);
    setVerdicts(db, ['a'], false, NOW);
    const c = dayConversations(db, config, t - 100, t + 100, { meaningless: 'include' }).items[0]!;
    assert.equal(c.activities[0]!.ai?.meaningless, false);
    assert.equal(c.activities[0]!.ai?.verdict, 'keep');
    assert.equal(c.meaningless, false);
  });
});

describe('meaningless 过滤', () => {
  const t = NOW - 3600;
  /** 三条互不相连的 FM 对话：纯空按、真对话、一半一半。 */
  function seeded() {
    const db = fresh();
    ins(db, [
      fm('kerchunk', t, { mine: true }),
      fm('real', t + 1000, { mine: true }),
      fm('half1', t + 2000, { mine: true }),
      fm('half2', t + 2030),
    ]);
    writeAiResults(db, [...noSpeech('kerchunk', 'half1'), { activityId: 'real', hasSpeech: true, category: 'qso' }, { activityId: 'half2', hasSpeech: true, category: 'qso' }], NOW);
    return db;
  }
  const ids = (page: { items: { id: string }[] }) => page.items.map((c) => c.id).sort();

  it('按天看缺省藏起无意义的', () => {
    const db = seeded();
    assert.deepEqual(ids(dayConversations(db, config, t - 100, t + 3000, {})), ['half1', 'real']);
  });

  it('only 只留无意义的，include 都留', () => {
    const db = seeded();
    assert.deepEqual(ids(dayConversations(db, config, t - 100, t + 3000, { meaningless: 'only' })), ['kerchunk']);
    assert.deepEqual(ids(dayConversations(db, config, t - 100, t + 3000, { meaningless: 'include' })), ['half1', 'kerchunk', 'real']);
  });

  it('参数不对就报 422', () => {
    assert.throws(() => dayConversations(seeded(), config, t - 100, t + 3000, { meaningless: 'maybe' }), /meaningless 只能是/);
  });

  // 已入库的是人看过的，AI 判错了也不能让它从已入库那一档里消失。
  it('已入库的永远不被藏，也不进 only', () => {
    const db = fresh();
    ins(db, [fm('a', t, { mine: true })]);
    writeAiResults(db, noSpeech('a'), NOW);
    insertQso(db, qsoOf('q1'));
    resolveActivities(db, ['a'], 'q1', NOW);
    const day = dayConversations(db, config, t - 100, t + 100, {});
    assert.deepEqual(day.items.map((c) => [c.id, c.status, c.meaningless]), [['a', 'logged', false]]);
    assert.deepEqual(dayConversations(db, config, t - 100, t + 100, { meaningless: 'only' }).items, []);
  });

  it('已忽略的照样判无意义', () => {
    const db = fresh();
    ins(db, [fm('a', t, { mine: true })]);
    writeAiResults(db, noSpeech('a'), NOW);
    resolveActivities(db, ['a'], null, NOW);
    assert.deepEqual(dayConversations(db, config, t - 100, t + 100, {}).items, []);
    assert.deepEqual(dayConversations(db, config, t - 100, t + 100, { meaningless: 'only' }).items.map((c) => c.status), ['ignored']);
  });

  it('数字侧没有识别结果，不会被藏', () => {
    const db = fresh();
    ins(db, [act('d', t, { dmrId: MY_ID })]);
    assert.deepEqual(ids(dayConversations(db, config, t - 100, t + 100, {})), ['d']);
  });

  // 过滤在分页和 total 之前。如果只给返回的那一页读 AI，页会短，total 会多。
  it('未入库：过滤在分页和 total 之前', () => {
    const db = fresh();
    const old = NOW - 5 * 86400;
    const rows: Activity[] = [];
    const results = [];
    for (let i = 0; i < 6; i++) {
      rows.push(fm(`c${i}`, old + i * 1000, { mine: true }));
      // c0 c1 c2 是空按，c3 c4 c5 是真对话；最新的是真对话
      results.push(i < 3 ? { activityId: `c${i}`, hasSpeech: false } : { activityId: `c${i}`, hasSpeech: true, category: 'qso' as const });
    }
    ins(db, rows);
    writeAiResults(db, results, NOW);

    const p1 = unloggedConversations(db, config, { limit: '2' });
    assert.deepEqual(p1.items.map((c) => c.id), ['c5', 'c4']);
    assert.equal(p1.total, 3);
    const p2 = unloggedConversations(db, config, { limit: '2', cursor: p1.next });
    assert.deepEqual(p2.items.map((c) => c.id), ['c3']);
    assert.equal(p2.next, undefined);

    const all = unloggedConversations(db, config, { meaningless: 'include' });
    assert.equal(all.total, 6);
  });

  it('待确认不含无意义的对话', () => {
    const db = seeded();
    assert.deepEqual(pendingConversations(db, config).map((c) => c.id).sort(), ['half1', 'real']);
  });

  it('搜呼号缺省把无意义的也列出来，要藏得显式 exclude', () => {
    const db = fresh();
    ins(db, [fm('x', t, { mine: true, callsign: 'BG0CG' })]);
    writeAiResults(db, noSpeech('x'), NOW);
    assert.deepEqual(searchConversations(db, config, 'BG0CG', {}).items.map((c) => c.id), ['x']);
    assert.deepEqual(searchConversations(db, config, 'BG0CG', { meaningless: 'exclude' }).items, []);
  });
});

describe('meaninglessConversations', () => {
  const t = NOW - 3600;
  const ids = (page: { items: { id: string }[] }) => page.items.map((c) => c.id);

  it('每次发射都无意义的对话，新的在前，带 total', () => {
    const db = fresh();
    ins(db, [fm('a', t, { mine: true }), fm('b', t + 1000), fm('c', t + 2000, { mine: true })]);
    writeAiResults(db, noSpeech('a', 'b', 'c'), NOW);
    const page = meaninglessConversations(db, config, {});
    assert.deepEqual(ids(page), ['c', 'b', 'a']);
    assert.equal(page.total, 3);
    const one = meaninglessConversations(db, config, { limit: '1' });
    assert.equal(one.items.length, 1);
    assert.equal(one.total, 3);
    assert.ok(one.next);
  });

  it('已忽略的无意义对话也列出来（忽略过的空按要能在这里看到、删掉）', () => {
    const db = fresh();
    ins(db, [fm('ign', t, { mine: true }), fm('open', t + 1000, { mine: true })]);
    writeAiResults(db, noSpeech('ign', 'open'), NOW);
    resolveActivities(db, ['ign'], null, NOW);
    const page = meaninglessConversations(db, config, {});
    assert.deepEqual(page.items.map((c) => [c.id, c.status]).sort(), [['ign', 'ignored'], ['open', 'pending']]);
  });

  it('已入库的不列，哪怕全是无意义', () => {
    const db = fresh();
    ins(db, [fm('a', t, { mine: true })]);
    writeAiResults(db, noSpeech('a'), NOW);
    insertQso(db, qsoOf('q1'));
    resolveActivities(db, ['a'], 'q1', NOW);
    assert.deepEqual(meaninglessConversations(db, config, {}).items, []);
  });

  it('一半无意义的对话不列', () => {
    const db = fresh();
    ins(db, [fm('a', t, { mine: true }), fm('b', t + 30)]);
    writeAiResults(db, [...noSpeech('a'), { activityId: 'b', hasSpeech: true, category: 'qso' }], NOW);
    assert.deepEqual(meaninglessConversations(db, config, {}).items, []);
  });

  it('没有本台成员的旁听也列出来', () => {
    const db = fresh();
    ins(db, [fm('over', t)]);
    writeAiResults(db, noSpeech('over'), NOW);
    assert.deepEqual(meaninglessConversations(db, config, {}).items.map((c) => c.status), ['overheard']);
  });

  it('不是无意义（人工改判）的不列，人工判定无意义的列', () => {
    const db = fresh();
    ins(db, [fm('a', t, { mine: true }), fm('b', t + 1000, { mine: true })]);
    writeAiResults(db, noSpeech('a'), NOW);
    setVerdicts(db, ['a'], false, NOW);
    setVerdicts(db, ['b'], true, NOW);
    assert.deepEqual(ids(meaninglessConversations(db, config, {})), ['b']);
  });

  it('同一段对话里相连的无意义发射合成一条', () => {
    const db = fresh();
    ins(db, [fm('a', t, { mine: true }), fm('b', t + 30), fm('c', t + 60, { mine: true })]);
    writeAiResults(db, noSpeech('a', 'b', 'c'), NOW);
    const page = meaninglessConversations(db, config, {});
    assert.equal(page.items.length, 1);
    assert.deepEqual(page.items[0]!.activities.map((a) => a.id), ['a', 'b', 'c']);
  });

  it('保留期之前的不列', () => {
    const db = fresh();
    const old = NOW - (config.activityRetentionDays + 1) * 86400;
    ins(db, [fm('old', old, { mine: true })]);
    writeAiResults(db, noSpeech('old'), NOW);
    assert.deepEqual(meaninglessConversations(db, config, {}).items, []);
  });

  it('origin 和 channel 仍然能过滤，请求里的 meaningless 不起作用', () => {
    const db = fresh();
    ins(db, [fm('a', t, { mine: true })]);
    writeAiResults(db, noSpeech('a'), NOW);
    assert.equal(meaninglessConversations(db, config, { origin: 'brandmeister' }).items.length, 0);
    assert.equal(meaninglessConversations(db, config, { meaningless: 'exclude' }).items.length, 1);
  });
});
