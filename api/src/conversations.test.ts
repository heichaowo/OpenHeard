import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Config } from './config.ts';
import type { Activity } from './core.ts';
import { dayConversations, searchConversations, unloggedConversations } from './conversations.ts';
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
