import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Activity, Qso } from './core.ts';
import {
  deleteQso,
  insertActivities,
  insertQso,
  openDb,
  pruneActivities,
  refreshStats,
  resolveActivities,
  selectQsos,
  selectUnresolvedActivities,
} from './db.ts';

const MY_ID = 4600123;

const act = (id: string, over: Partial<Activity> = {}): Activity => ({
  id,
  origin: 'brandmeister',
  startAt: 1_789_000_000,
  durationS: 5,
  mine: false,
  ...over,
});

const row = (a: Activity) => ({ activity: a, raw: JSON.stringify({ SessionID: a.id }) });

const fresh = () => openDb(':memory:');

const qso = (id: string, over: Partial<Qso> = {}): Qso => ({
  id,
  call: 'BD7KLO',
  startAt: 1_789_000_000,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'DMR',
  rstSent: '59',
  rstRcvd: '59',
  createdAt: 1_789_000_100,
  ...over,
});

describe('写入判重', () => {
  it('同一个 id 写两次只算一行', () => {
    const db = fresh();
    assert.equal(insertActivities(db, [row(act('a')), row(act('b'))], 1), 2);
    assert.equal(insertActivities(db, [row(act('a')), row(act('b'))], 2), 0);
    assert.equal(insertActivities(db, [row(act('b')), row(act('c'))], 3), 1);
  });

  it('原始行照原样存下来', () => {
    const db = fresh();
    insertActivities(db, [{ activity: act('a'), raw: '{"Master":4501}' }], 1);
    const r = db.prepare('SELECT raw FROM activity WHERE id = ?').get('a') as { raw: string };
    assert.equal(r.raw, '{"Master":4501}');
  });
});

describe('mine 的来源', () => {
  it('数字侧按 dmr_id 推，改了配置历史行跟着对', () => {
    const db = fresh();
    insertActivities(db, [row(act('a', { dmrId: MY_ID, mine: false }))], 1);
    // 写入时 mine 传的是 false，读出来应当按 dmrId 判定为 true
    assert.equal(selectUnresolvedActivities(db, 0, MY_ID)[0]!.mine, true);
    // 换一个 DMR ID，同一行就不再是本台的
    assert.equal(selectUnresolvedActivities(db, 0, 999)[0]!.mine, false);
  });

  it('模拟侧存下来，不受 dmr_id 影响', () => {
    const db = fresh();
    insertActivities(db, [row(act('a', { origin: 'sdr-fm', mine: true }))], 1);
    assert.equal(selectUnresolvedActivities(db, 0, 999)[0]!.mine, true);
  });
});

describe('已处理的行不再出现', () => {
  it('提升之后整段都不回队列', () => {
    const db = fresh();
    insertActivities(db, [row(act('a')), row(act('b')), row(act('c'))], 1);
    insertQso(db, qso('q1'));
    resolveActivities(db, ['a', 'b'], 'q1', 2);
    assert.deepEqual(
      selectUnresolvedActivities(db, 0, MY_ID).map((a) => a.id),
      ['c'],
    );
  });

  it('忽略也一样，qso_id 为空', () => {
    const db = fresh();
    insertActivities(db, [row(act('a')), row(act('b'))], 1);
    resolveActivities(db, ['a'], null, 2);
    assert.deepEqual(
      selectUnresolvedActivities(db, 0, MY_ID).map((x) => x.id),
      ['b'],
    );
  });

  it('后到的更早的行不会让已处理的对话复活', () => {
    const db = fresh();
    insertActivities(db, [row(act('b', { startAt: 1000 }))], 1);
    resolveActivities(db, ['b'], 'q1', 2);
    // 同一段对话里更早的一条晚一步才入库
    insertActivities(db, [row(act('a', { startAt: 900 }))], 3);
    const left = selectUnresolvedActivities(db, 0, MY_ID).map((x) => x.id);
    assert.deepEqual(left, ['a']);
    assert.ok(!left.includes('b'));
  });

  it('窗口外的行不取', () => {
    const db = fresh();
    insertActivities(db, [row(act('old', { startAt: 100 })), row(act('new', { startAt: 900 }))], 1);
    assert.deepEqual(
      selectUnresolvedActivities(db, 500, MY_ID).map((x) => x.id),
      ['new'],
    );
  });
});

describe('删掉通联', () => {
  it('对应的发射回到待确认队列', () => {
    const db = fresh();
    insertActivities(db, [row(act('a')), row(act('b'))], 1);
    insertQso(db, qso('q1'));
    resolveActivities(db, ['a', 'b'], 'q1', 2);
    assert.equal(selectUnresolvedActivities(db, 0, MY_ID).length, 0);

    assert.equal(deleteQso(db, 'q1', 1), true);
    assert.equal(selectQsos(db).length, 0);
    assert.deepEqual(
      selectUnresolvedActivities(db, 0, MY_ID).map((x) => x.id),
      ['a', 'b'],
    );
  });

  it('删不存在的返回 false', () => {
    assert.equal(deleteQso(fresh(), 'nope', 1), false);
  });

  it('被忽略的行不受删通联影响', () => {
    const db = fresh();
    insertActivities(db, [row(act('a')), row(act('b'))], 1);
    insertQso(db, qso('q1'));
    resolveActivities(db, ['a'], 'q1', 2);
    resolveActivities(db, ['b'], null, 2);
    deleteQso(db, 'q1', 1);
    assert.deepEqual(
      selectUnresolvedActivities(db, 0, MY_ID).map((x) => x.id),
      ['a'],
    );
  });
});

describe('裁剪', () => {
  it('跳过已经被提升或忽略引用的行', () => {
    const db = fresh();
    insertActivities(
      db,
      [row(act('a', { startAt: 100 })), row(act('b', { startAt: 100 })), row(act('c', { startAt: 900 }))],
      1,
    );
    insertQso(db, qso('q1'));
    resolveActivities(db, ['a'], 'q1', 2);
    // 返回被裁掉那些行的 id，调用方据此把对应的录音也删掉
    assert.deepEqual(pruneActivities(db, 500), ['b']);
    const ids = (db.prepare('SELECT id FROM activity ORDER BY id').all() as { id: string }[]).map(
      (r) => r.id,
    );
    assert.deepEqual(ids, ['a', 'c']);
  });
});

describe('通联字段往返', () => {
  it('可选字段缺了就是 undefined，不是 null', () => {
    const db = fresh();
    insertQso(db, qso('q1', { myQth: '成都', myHeightM: 30 }));
    const [q] = selectQsos(db);
    assert.equal(q!.myQth, '成都');
    assert.equal(q!.myHeightM, 30);
    assert.equal(q!.gridsquare, undefined);
    assert.equal(q!.note, undefined);
  });

  it('按开始时间倒序', () => {
    const db = fresh();
    insertQso(db, qso('old', { startAt: 100 }));
    insertQso(db, qso('new', { startAt: 900 }));
    assert.deepEqual(selectQsos(db).map((q) => q.id), ['new', 'old']);
  });
});

describe('refreshStats', () => {
  // 从没统计过的库，规划器把呼号区间当成不挑剔，搜少见呼号也倒着扫时间索引。
  // 统计过之后少见的前缀要走呼号索引，常见的前缀照样走时间索引。
  const plan = (db: ReturnType<typeof openDb>, lo: string, hi: string) =>
    (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM activity WHERE callsign >= ? AND callsign < ?
             AND start_at >= 0 AND start_at < 9999999999 ORDER BY start_at DESC LIMIT 200`,
        )
        .all(lo, hi) as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');

  it('统计之后，少见的呼号前缀走呼号索引', () => {
    const db = openDb(':memory:');
    const rows = Array.from({ length: 20_000 }, (_, i) =>
      row(act(`a${i}`, { startAt: 1_789_000_000 + i * 30, callsign: `BG${i % 2000}X`, talkgroup: 46001 })),
    );
    insertActivities(db, rows, 1);
    assert.match(plan(db, 'ZZ9', 'ZZ:'), /activity_start_at/);

    refreshStats(db);
    assert.match(plan(db, 'ZZ9', 'ZZ:'), /activity_callsign/);
    assert.match(plan(db, 'BG', 'BH'), /activity_start_at/);
  });

  const firstCount = (db: ReturnType<typeof openDb>) =>
    Number((db.prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = 'activity' LIMIT 1").get() as { stat: string }).stat.split(' ')[0]);
  const many = (from: number, count: number) =>
    Array.from({ length: count }, (_, k) => {
      const i = from + k;
      return row(act(`a${i}`, { startAt: 1_789_000_000 + i * 30, callsign: `BG${i % 2000}X`, talkgroup: 46001 }));
    });

  // PRAGMA optimize 在表涨了十倍之后会按采样重跑，采样出来的统计又把呼号搜索
  // 带回时间索引。表涨过一倍就要完整重跑，统计里的行数是准的。
  it('行数翻倍之后完整重跑，统计里的行数是准的', () => {
    const db = openDb(':memory:');
    insertActivities(db, many(0, 2_000), 1);
    refreshStats(db);
    assert.equal(firstCount(db), 2_000);

    insertActivities(db, many(2_000, 18_000), 1);
    refreshStats(db);
    assert.equal(firstCount(db), 20_000);
    assert.match(plan(db, 'ZZ9', 'ZZ:'), /activity_callsign/);
  });

  // 每小时都完整重跑的话，25 万行每次要卡住别的请求 140 毫秒。
  it('行数没怎么变就不重跑', () => {
    const db = openDb(':memory:');
    insertActivities(db, many(0, 2_000), 1);
    refreshStats(db);
    insertActivities(db, many(2_000, 1_000), 1);
    refreshStats(db);
    assert.equal(firstCount(db), 2_000);
  });

  it('空表不统计，有了数据再统计', () => {
    const db = openDb(':memory:');
    refreshStats(db);
    insertActivities(db, many(0, 10), 1);
    refreshStats(db);
    assert.equal(firstCount(db), 10);
  });
});
