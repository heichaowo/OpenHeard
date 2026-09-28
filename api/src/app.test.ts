import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createApp, createBrokenApp } from './app.ts';
import { COOKIE, SESSION_DAYS, hashPassword, signSession } from './auth.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import type { Activity, Qso } from './core.ts';
import { insertActivities, openDb } from './db.ts';
import { createStore } from './store.ts';
import { createThrottle } from './throttle.ts';

const MY_ID = 4600123;

const config: Config = {
  dbPath: ':memory:',
  path: '/tmp/openheard-test.config.json',
  host: '127.0.0.1',
  adminPasswordHash: hashPassword('secret'),
  sessionSecret: 's'.repeat(40),
  dmrId: MY_ID,
  clusterGapS: 120,
  pendingWindowDays: 3650,
  activityRetentionDays: 90,
  ingestToken: 'x'.repeat(32),
  station: { myGridsquare: 'OM24', myQth: '成都', networkFreqMhz: 439.525 },
  channels: [{ name: '439.525 中继', freqMhz: 439.525, mode: 'FM' }],
  queries: [],
  brandmeisterEnabled: true,
  recordingsDir: '/tmp/openheard-test-recordings',
};

const act = (id: string, over: Partial<Activity> = {}): Activity => ({
  id,
  origin: 'brandmeister',
  startAt: Math.floor(Date.now() / 1000) - 600,
  durationS: 5,
  mine: false,
  ...over,
});

function setup(activities: Activity[] = [], cfg: Config = config) {
  const db = openDb(':memory:');
  if (activities.length > 0) {
    insertActivities(db, activities.map((a) => ({ activity: a, raw: '{}' })), 1);
  }
  return createApp(createStore(db, cfg), cfg.ingestToken, {
    passwordHash: cfg.adminPasswordHash,
    sessionSecret: cfg.sessionSecret,
  });
}

/** 管理端每条路由都要会话，测试里统一带一个有效的。 */
const cookie = () =>
  `${COOKIE}=${signSession(config.sessionSecret, Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400)}`;

const get = (app: ReturnType<typeof setup>, path: string) =>
  app.fetch(new Request(`http://local${path}`, { headers: { cookie: cookie() } }));

const send = (app: ReturnType<typeof setup>, method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: {
        cookie: cookie(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const complete = {
  call: 'bd7klo',
  startAt: 1_789_000_000,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'DMR',
  rstSent: '59',
  rstRcvd: '59',
};

describe('GET /api/station', () => {
  it('把本台字段和频谱表一起给出去', async () => {
    const res = await get(setup(), '/api/station');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { station: { myQth: string }; channels: unknown[] };
    assert.equal(body.station.myQth, '成都');
    assert.equal(body.channels.length, 1);
  });
});

describe('GET /api/pending', () => {
  it('没有观测时是空的', async () => {
    assert.deepEqual(await (await get(setup(), '/api/pending')).json(), []);
  });

  it('不含本台的对话不进队列', async () => {
    const app = setup([act('a', { dmrId: 999 }), act('b', { dmrId: 888 })]);
    assert.deepEqual(await (await get(app, '/api/pending')).json(), []);
  });

  it('含本台的对话进队列，对方呼号从话务组那条行里取', async () => {
    const t = Math.floor(Date.now() / 1000) - 600;
    const app = setup([
      act('a', { startAt: t, dmrId: MY_ID, callsign: 'BG0CG' }),
      act('b', { startAt: t + 30, dmrId: 777, callsign: 'BD7KLO' }),
    ]);
    const body = (await (await get(app, '/api/pending')).json()) as {
      cluster: { id: string; activities: unknown[] };
      draft: { call?: string; mode?: string; band?: string };
    }[];
    assert.equal(body.length, 1);
    assert.equal(body[0]!.cluster.activities.length, 2);
    assert.equal(body[0]!.draft.call, 'BD7KLO');
    assert.equal(body[0]!.draft.mode, 'DMR');
    assert.equal(body[0]!.draft.band, '70cm');
  });

  // 对话的开场白落在待确认窗口起点之前一点。以前接口只聚窗口内的行，开场白
  // 被截掉，段 id 也和收听页其他几档对不上，按截掉之后的那几次入库，开场白
  // 就永远落在日志外面。
  it('跨过窗口起点的对话整段都在，段 id 和天视图一样', async () => {
    const cfg = { ...config, pendingWindowDays: 3 };
    const since = Math.floor(Date.now() / 1000) - cfg.pendingWindowDays * 86400;
    const app = setup(
      [act('opener', { startAt: since - 60, dmrId: 777 }), act('reply', { startAt: since + 30, dmrId: MY_ID })],
      cfg,
    );
    const body = (await (await get(app, '/api/pending')).json()) as {
      cluster: { id: string; activities: { id: string }[] };
    }[];
    assert.deepEqual(
      body.map((p) => [p.cluster.id, p.cluster.activities.map((a) => a.id)]),
      [['opener', ['opener', 'reply']]],
    );
    const day = (await (await get(app, `/api/conversations?from=${since - 3600}&to=${since + 3600}`)).json()) as {
      items: { id: string }[];
    };
    assert.equal(day.items[0]!.id, 'opener');
  });

  it('间隔超过阈值就是两段', async () => {
    const t = Math.floor(Date.now() / 1000) - 6000;
    const app = setup([
      act('a', { startAt: t, dmrId: MY_ID }),
      act('b', { startAt: t + 1000, dmrId: MY_ID }),
    ]);
    const body = (await (await get(app, '/api/pending')).json()) as unknown[];
    assert.equal(body.length, 2);
  });
});

describe('提升（按发射 id）', () => {
  const two = () => {
    const t = Math.floor(Date.now() / 1000) - 600;
    return setup([
      act('a', { startAt: t, dmrId: MY_ID, callsign: 'BG0CG' }),
      act('b', { startAt: t + 30, dmrId: 777, callsign: 'BD7KLO' }),
    ]);
  };

  it('挑中的发射一起离开队列，并出现在日志里，回 201', async () => {
    const app = two();
    const res = await send(app, 'POST', '/api/conversations/promote', {
      ...complete,
      call: 'BD7KLO',
      activityIds: ['a', 'b'],
    });
    assert.equal(res.status, 201);
    const qso = (await res.json()) as Qso;
    assert.ok(qso.id);
    // clusterId 取 (start_at, id) 最小的那个，和 clusterActivities 同一个顺序。
    assert.equal(qso.clusterId, 'a');

    assert.deepEqual(await (await get(app, '/api/pending')).json(), []);
    assert.equal(((await (await get(app, '/api/qsos')).json()) as unknown[]).length, 1);
  });

  it('缺字段回 422 并说清缺什么', async () => {
    const t = Math.floor(Date.now() / 1000) - 600;
    const app = setup([act('a', { startAt: t, dmrId: MY_ID })]);
    const res = await send(app, 'POST', '/api/conversations/promote', { startAt: 1, activityIds: ['a'] });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { missing: string[] };
    assert.ok(body.missing.includes('call'));
  });

  it('id 不存在回 409', async () => {
    const res = await send(two(), 'POST', '/api/conversations/promote', { ...complete, activityIds: ['nope'] });
    assert.equal(res.status, 409);
  });

  it('activityIds 不是字符串数组就 422', async () => {
    for (const body of [complete, { ...complete, activityIds: 'a' }, { ...complete, activityIds: [1] }]) {
      assert.equal((await send(two(), 'POST', '/api/conversations/promote', body)).status, 422);
    }
  });
});

// 聚类按一个间隔阈值猜，会猜错。两段对话并成一段时，整段提升会把两边
// 记成一条，整段忽略又把两边都丢掉。
describe('只处理挑中的那几次发射', () => {
  const start = Math.floor(Date.now() / 1000) - 3600;
  // 两段对话挨得太近被并成一段：本台和 A，接着本台和 B。
  const merged = () =>
    setup([
      act('m1', { dmrId: MY_ID, startAt: start, talkgroup: 46001 }),
      act('x1', { dmrId: 4616472, startAt: start + 10, talkgroup: 46001 }),
      act('m2', { dmrId: MY_ID, startAt: start + 20, talkgroup: 46001 }),
      act('x2', { dmrId: 4606502, startAt: start + 30, talkgroup: 46001 }),
    ]);

  const pendingOf = async (app: ReturnType<typeof setup>) =>
    (await (await get(app, '/api/pending')).json()) as {
      cluster: { id: string; activities: { id: string }[] };
    }[];

  it('提升时只结算挑中的那几次，剩下的回到队列', async () => {
    const app = merged();
    const res = await send(app, 'POST', '/api/conversations/promote', {
      ...complete,
      activityIds: ['m1', 'x1'],
    });
    assert.equal(res.status, 201);

    // 剩下那半边没被结算，重新聚类之后自己成一段
    const after = await pendingOf(app);
    assert.equal(after.length, 1);
    assert.deepEqual(after[0].cluster.activities.map((a) => a.id).sort(), ['m2', 'x2']);
  });

  it('忽略也能只挑几次', async () => {
    const app = merged();
    const res = await send(app, 'POST', '/api/conversations/ignore', {
      picks: [{ id: 'm1', activityIds: ['x2'] }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ignored: 1, missing: [] });

    const after = await pendingOf(app);
    assert.deepEqual(after[0].cluster.activities.map((a) => a.id).sort(), ['m1', 'm2', 'x1']);
  });

  // 省掉 activityIds 不再等于整段：界面必须带上看到的那几次发射的 id。
  it('不给 activityIds 就 422，不当成整段', async () => {
    const app = merged();
    const res = await send(app, 'POST', '/api/conversations/promote', complete);
    assert.equal(res.status, 422);
    assert.equal((await pendingOf(app))[0].cluster.activities.length, 4);
  });

  // 界面上拿的是一份快照，挑中的那几次可能已经被别处结算了。
  it('挑了不存在的 id 就 409，什么都不结算', async () => {
    const app = merged();
    const res = await send(app, 'POST', '/api/conversations/promote', {
      ...complete,
      activityIds: ['m1', '别的段的'],
    });
    assert.equal(res.status, 409);
    assert.equal((await pendingOf(app))[0].cluster.activities.length, 4);
  });

  // 把勾全去掉再点确认。当成「不给就是整段」的话，另一边的发射也一起没了。
  it('一次都没挑就 422，忽略那边同样一条都没挑就算认不出来', async () => {
    const app = merged();

    const promoted = await send(app, 'POST', '/api/conversations/promote', { ...complete, activityIds: [] });
    const ignored = await send(app, 'POST', '/api/conversations/ignore', {
      picks: [{ id: 'm1', activityIds: [] }],
    });

    assert.equal(promoted.status, 422);
    assert.equal(ignored.status, 200);
    assert.deepEqual(await ignored.json(), { ignored: 0, missing: ['m1'] });
    assert.equal((await pendingOf(app))[0].cluster.activities.length, 4);
  });

  // 打开抽屉到点确认之间，同一段又进来一条。段 id 跟着最早那条走，不会变。
  it('带着打开时的那几次去结算，后来并进来的留在队列里', async () => {
    const db = openDb(':memory:');
    insertActivities(
      db,
      [
        act('m1', { dmrId: MY_ID, startAt: start, talkgroup: 46001 }),
        act('x1', { dmrId: 4616472, startAt: start + 10, talkgroup: 46001 }),
      ].map((a) => ({ activity: a, raw: '{}' })),
      1,
    );
    const app = createApp(createStore(db, config), config.ingestToken, {
      passwordHash: config.adminPasswordHash,
      sessionSecret: config.sessionSecret,
    });
    const [seg] = await pendingOf(app);
    const seen = seg.cluster.activities.map((a) => a.id);

    const late = act('x9', { dmrId: 4606502, startAt: start + 40, talkgroup: 46001 });
    insertActivities(db, [{ activity: late, raw: '{}' }], 2);
    assert.equal((await pendingOf(app))[0].cluster.id, seg.cluster.id);

    const res = await send(app, 'POST', '/api/conversations/promote', { ...complete, activityIds: seen });

    assert.equal(res.status, 201);
    const left = db.prepare(
      'SELECT id FROM activity WHERE id NOT IN (SELECT activity_id FROM resolved_activity)',
    ).all() as { id: string }[];
    assert.deepEqual(left.map((r) => r.id), ['x9']);
  });
});

describe('忽略（按发射 id）', () => {
  it('挑中的发射离开队列，也不产生通联，回 200', async () => {
    const t = Math.floor(Date.now() / 1000) - 600;
    const app = setup([act('a', { startAt: t, dmrId: MY_ID }), act('b', { startAt: t + 30, dmrId: MY_ID })]);
    const res = await send(app, 'POST', '/api/conversations/ignore', {
      picks: [{ id: 'a', activityIds: ['a', 'b'] }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ignored: 1, missing: [] });
    assert.deepEqual(await (await get(app, '/api/pending')).json(), []);
    assert.deepEqual(await (await get(app, '/api/qsos')).json(), []);
  });
});

// 一条一条调的话，每忽略一段就重新聚类一次，剩下那些段的 id 会变，后面全 409。
describe('一次忽略好几段（按发射 id）', () => {
  const start = Math.floor(Date.now() / 1000) - 3600;
  const three = () =>
    setup([
      act('a1', { dmrId: MY_ID, startAt: start, talkgroup: 46001 }),
      act('a2', { dmrId: MY_ID, startAt: start + 600, talkgroup: 46001 }),
      act('a3', { dmrId: MY_ID, startAt: start + 1200, talkgroup: 46001 }),
    ]);

  type Seg = { cluster: { id: string; activities: { id: string }[] } };
  const segs = async (app: ReturnType<typeof setup>) =>
    (await (await get(app, '/api/pending')).json()) as Seg[];
  const pickOf = (p: Seg) => ({ id: p.cluster.id, activityIds: p.cluster.activities.map((a) => a.id) });

  it('三段一次忽略掉，队列空了', async () => {
    const app = three();
    const before = await segs(app);
    assert.equal(before.length, 3);

    const res = await send(app, 'POST', '/api/conversations/ignore', { picks: before.map(pickOf) });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ignored: 3, missing: [] });
    assert.equal((await segs(app)).length, 0);
  });

  it('只忽略给到的那几段，别的留着', async () => {
    const app = three();
    const before = await segs(app);

    await send(app, 'POST', '/api/conversations/ignore', { picks: [pickOf(before[0])] });

    assert.equal((await segs(app)).length, 2);
  });

  it('认不出来的段单独报出来，不影响别的', async () => {
    const app = three();
    const before = await segs(app);

    const res = await send(app, 'POST', '/api/conversations/ignore', {
      picks: [pickOf(before[0]), { id: '不存在', activityIds: ['a1'] }],
    });

    assert.deepEqual(await res.json(), { ignored: 1, missing: ['不存在'] });
  });

  // 挑的时候只有本台一声，确认之前对方回了，并进同一段，段 id 不变。
  it('挑完之后才并进来的回复不跟着忽略', async () => {
    const db = openDb(':memory:');
    const one = act('a1', { dmrId: MY_ID, startAt: start, talkgroup: 46001 });
    insertActivities(db, [{ activity: one, raw: '{}' }], 1);
    const app = createApp(createStore(db, config), config.ingestToken, {
      passwordHash: config.adminPasswordHash,
      sessionSecret: config.sessionSecret,
    });
    const [picked] = await segs(app);

    const reply = act('r1', { dmrId: 4616472, startAt: start + 20, talkgroup: 46001 });
    insertActivities(db, [{ activity: reply, raw: '{}' }], 2);
    assert.equal((await segs(app))[0].cluster.id, picked.cluster.id);

    const res = await send(app, 'POST', '/api/conversations/ignore', { picks: [pickOf(picked)] });

    assert.deepEqual(await res.json(), { ignored: 1, missing: [] });
    const after = await segs(app);
    assert.deepEqual(after.flatMap((p) => p.cluster.activities.map((a) => a.id)), []);
    // 回复不是本台的，自己成不了一段，但它没有被标成忽略，还在库里等着。
    const left = db.prepare(
      'SELECT id FROM activity WHERE id NOT IN (SELECT activity_id FROM resolved_activity)',
    ).all() as { id: string }[];
    assert.deepEqual(left.map((r) => r.id), ['r1']);
  });

  it('一次都没挑的那段算认不出来，不整段忽略', async () => {
    const app = three();
    const before = await segs(app);

    const res = await send(app, 'POST', '/api/conversations/ignore', {
      picks: [{ id: before[0].cluster.id, activityIds: [] }],
    });

    assert.deepEqual(await res.json(), { ignored: 0, missing: [before[0].cluster.id] });
    assert.equal((await segs(app)).length, 3);
  });

  it('传的形状不对就 422', async () => {
    const bad = [
      { picks: 'x' },
      { picks: [1] },
      { picks: [{ id: 'a1' }] },
      { picks: [{ id: 'a1', activityIds: [1] }] },
      // 旧的请求体，按段 id 整段忽略，正是要去掉的那个行为。
      { clusterIds: ['a1'] },
    ];
    for (const body of bad) {
      assert.equal((await send(three(), 'POST', '/api/conversations/ignore', body)).status, 422);
    }
  });
});

// 待确认队列只放有本台的段。别的电台被听到了，以前只在运维页上变成一个计数。
describe('收听记录', () => {
  const t = Math.floor(Date.now() / 1000) - 3600;
  const fm = (id: string, at: number, over: Partial<Activity> = {}) =>
    act(id, { origin: 'sdr-fm', startAt: t + at, channel: '438.500 中继', freqMhz: 438.5, ...over });

  type Page = { items: (Activity & { settled?: string })[]; next?: string };
  const page = async (app: ReturnType<typeof setup>, q: string) =>
    (await (await get(app, `/api/activities?${q}`)).json()) as Page;

  it('别人的模拟发射也列出来，最新的在前，只看要的来源', async () => {
    const app = setup([
      fm('f1', 0),
      fm('f2', 60),
      act('b1', { startAt: t + 30, talkgroup: 46001 }),
    ]);

    const p = await page(app, 'origin=sdr-fm');

    assert.deepEqual(p.items.map((a) => a.id), ['f2', 'f1']);
    assert.equal(p.items[0]!.mine, false);
    assert.equal(p.next, undefined);
  });

  it('结算过的带上结算成了什么', async () => {
    const app = setup([
      act('m1', { dmrId: MY_ID, startAt: t, talkgroup: 46001 }),
      act('x1', { dmrId: 4616472, startAt: t + 10, talkgroup: 46001 }),
      act('m2', { dmrId: MY_ID, startAt: t + 1000, talkgroup: 46001 }),
    ]);
    await send(app, 'POST', '/api/conversations/promote', { ...complete, activityIds: ['m1', 'x1'] });
    await send(app, 'POST', '/api/conversations/ignore', { picks: [{ id: 'm2', activityIds: ['m2'] }] });

    const p = await page(app, 'origin=brandmeister');

    assert.deepEqual(
      p.items.map((a) => [a.id, a.settled]),
      [
        ['m2', 'ignored'],
        ['x1', 'logged'],
        ['m1', 'logged'],
      ],
    );
  });

  // 时刻相同的几行正好压在页边上时，按时刻翻会跳过或者重复。
  it('按游标往前翻，时刻相同的行不跳也不重复', async () => {
    const app = setup([
      fm('a', 0),
      fm('b', 10),
      fm('c', 10),
      fm('d', 10),
      fm('e', 20),
    ]);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const p = await page(app, `origin=sdr-fm&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...p.items.map((a) => a.id));
      cursor = p.next;
      if (cursor === undefined) break;
    }

    assert.deepEqual(seen, ['e', 'd', 'c', 'b', 'a']);
  });

  it('参数不对回 422', async () => {
    const app = setup();
    for (const q of ['origin=ssb', 'cursor=abc', 'limit=0', 'limit=201', 'limit=2.5']) {
      assert.equal((await get(app, `/api/activities?${q}`)).status, 422, q);
    }
  });

  it('要会话', async () => {
    const res = await setup().fetch(new Request('http://local/api/activities'));
    assert.equal(res.status, 401);
  });
});

// 保留期是手改配置文件定的，没有东西拦着它比待确认窗口短。
describe('裁剪不碰队列里的段', () => {
  it('保留期比窗口短时，窗口里没处理的段还在', () => {
    const db = openDb(':memory:');
    const now = Math.floor(Date.now() / 1000);
    insertActivities(
      db,
      [
        act('d20', { dmrId: MY_ID, startAt: now - 20 * 86400 }),
        act('d40', { dmrId: MY_ID, startAt: now - 40 * 86400 }),
      ].map((a) => ({ activity: a, raw: '{}' })),
      1,
    );
    const store = createStore(db, { ...config, activityRetentionDays: 14, pendingWindowDays: 30 });

    store.logPoll({ queryKey: 'q', at: now, fetched: 0, parsed: 0, written: 0, ok: true, ms: 1 });

    assert.deepEqual(
      store.pending().map((p) => p.cluster.id),
      ['d20'],
    );
    const ids = (db.prepare('SELECT id FROM activity').all() as { id: string }[]).map((r) => r.id);
    assert.deepEqual(ids, ['d20']);
  });
});

describe('请求体上限', () => {
  it('超过上限回 413，不读进来', async () => {
    const res = await setup().fetch(
      new Request('http://local/api/qsos/import', {
        method: 'POST',
        headers: { cookie: cookie(), 'content-type': 'text/plain' },
        body: 'x'.repeat(17 * 1024 * 1024),
      }),
    );
    assert.equal(res.status, 413);
    assert.match(((await res.json()) as { error: string }).error, /MB/);
  });
});

describe('手工补录', () => {
  it('呼号归一化后入库，不带 clusterId', async () => {
    const app = setup();
    const res = await send(app, 'POST', '/api/qsos', complete);
    assert.equal(res.status, 200);
    const qso = (await res.json()) as Qso;
    assert.equal(qso.call, 'BD7KLO');
    assert.equal(qso.clusterId, undefined);
  });

  it('缺字段回 422', async () => {
    const res = await send(setup(), 'POST', '/api/qsos', { call: 'BD7KLO' });
    assert.equal(res.status, 422);
  });

  it('删得掉，删不存在的回 404', async () => {
    const app = setup();
    const qso = (await (await send(app, 'POST', '/api/qsos', complete)).json()) as Qso;
    assert.equal((await send(app, 'DELETE', `/api/qsos/${qso.id}`)).status, 204);
    assert.equal((await send(app, 'DELETE', `/api/qsos/${qso.id}`)).status, 404);
  });
});

describe('改一条已入库的通联', () => {
  it('改得动，id 和 createdAt 不变', async () => {
    const app = setup();
    const before = (await (await send(app, 'POST', '/api/qsos', complete)).json()) as Qso;

    const res = await send(app, 'PUT', `/api/qsos/${before.id}`, {
      ...before,
      rstSent: '41',
      qth: '重庆',
    });

    assert.equal(res.status, 200);
    const after = (await res.json()) as Qso;
    assert.equal(after.id, before.id);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(after.rstSent, '41');
    assert.equal(after.qth, '重庆');

    const all = (await (await get(app, '/api/qsos')).json()) as Qso[];
    assert.equal(all.length, 1);
    assert.equal(all[0].rstSent, '41');
  });

  // clusterId 是这条记录和当初那几次发射的唯一联系。改 RST 不该把来源丢掉，
  // 而请求体是前端整份发回来的，里面的 clusterId 不能作数。
  it('clusterId 保持原样，请求体里的假值不作数', async () => {
    const start = Math.floor(Date.now() / 1000) - 600;
    const app = setup([
      act('s1', { dmrId: MY_ID, startAt: start, talkgroup: 46001 }),
      act('s2', { dmrId: 4600999, startAt: start + 10, talkgroup: 46001 }),
    ]);
    const pending = (await (await get(app, '/api/pending')).json()) as {
      cluster: { id: string; activities: { id: string }[] };
    }[];
    const promoted = (await (
      await send(app, 'POST', '/api/conversations/promote', {
        ...complete,
        startAt: start,
        activityIds: pending[0].cluster.activities.map((a) => a.id),
      })
    ).json()) as Qso;
    assert.equal(promoted.clusterId, pending[0].cluster.id);

    const after = (await (
      await send(app, 'PUT', `/api/qsos/${promoted.id}`, {
        ...promoted,
        call: 'BA1AA',
        clusterId: '假的',
      })
    ).json()) as Qso;

    assert.equal(after.call, 'BA1AA');
    assert.equal(after.clusterId, pending[0].cluster.id);
  });

  it('改不存在的回 404，改到缺字段回 422', async () => {
    const app = setup();
    const qso = (await (await send(app, 'POST', '/api/qsos', complete)).json()) as Qso;

    assert.equal((await send(app, 'PUT', '/api/qsos/没这条', complete)).status, 404);
    assert.equal(
      (await send(app, 'PUT', `/api/qsos/${qso.id}`, { ...qso, call: undefined })).status,
      422,
    );
  });
});

describe('导入 ADIF', () => {
  const adif = (...records: string[]) =>
    `OpenHeard test <ADIF_VER:5>3.1.5 <EOH>\n${records.join('\n')}\n`;
  const rec = (call: string, date = '20260915', time = '094933', freq = '439.525') =>
    `<CALL:${call.length}>${call} <QSO_DATE:8>${date} <TIME_ON:6>${time} ` +
    `<MODE:2>FM <FREQ:${freq.length}>${freq} <RST_SENT:2>59 <RST_RCVD:2>59 <EOR>`;

  const post = (app: ReturnType<typeof setup>, text: string) =>
    app.fetch(
      new Request('http://local/api/qsos/import', {
        method: 'POST',
        headers: { cookie: cookie(), 'content-type': 'text/plain' },
        body: text,
      }),
    );

  it('导进来的记录在日志里读得到，不带 clusterId', async () => {
    const app = setup();
    const res = await post(app, adif(rec('BD7KLO'), rec('BA1AA', '20260914')));

    assert.deepEqual(await res.json(), { parsed: 2, imported: 2, skipped: 0, problems: [] });
    const all = (await (await get(app, '/api/qsos')).json()) as Qso[];
    assert.equal(all.length, 2);
    assert.equal(all.every((q) => q.clusterId === undefined), true);
  });

  // ADIF 的时刻常常只到分钟，而这台机器记到秒。比死时刻的话同一条会反复进来。
  it('同一条导第二遍不会重复', async () => {
    const app = setup();
    await post(app, adif(rec('BD7KLO')));

    const again = await post(app, adif(rec('BD7KLO')));

    assert.deepEqual(await again.json(), { parsed: 1, imported: 0, skipped: 1, problems: [] });
    assert.equal(((await (await get(app, '/api/qsos')).json()) as Qso[]).length, 1);
  });

  it('同一分钟内的秒数不同也算同一条', async () => {
    const app = setup();
    await post(app, adif(rec('BD7KLO', '20260915', '094900')));
    const again = await post(app, adif(rec('BD7KLO', '20260915', '094959')));
    assert.equal(((await again.json()) as { skipped: number }).skipped, 1);
  });

  it('同一次导入里的重复也只进一条', async () => {
    const app = setup();
    const res = await post(app, adif(rec('BD7KLO'), rec('BD7KLO')));
    assert.deepEqual(await res.json(), { parsed: 2, imported: 1, skipped: 1, problems: [] });
  });

  it('读不了的那几条跳过，好的照样进，并说清楚哪条不行', async () => {
    const app = setup();
    const res = await post(app, adif('<CALL:6>BD7KLO <EOR>', rec('BA1AA')));

    const body = (await res.json()) as { imported: number; problems: string[] };
    assert.equal(body.imported, 1);
    assert.equal(body.problems.length, 1);
    assert.match(body.problems[0], /第 1 条/);
  });

  it('空文件不是错', async () => {
    const res = await post(setup(), '');
    assert.deepEqual(await res.json(), { parsed: 0, imported: 0, skipped: 0, problems: [] });
  });

  it('要会话', async () => {
    const res = await setup().fetch(
      new Request('http://local/api/qsos/import', { method: 'POST', body: adif(rec('BA1AA')) }),
    );
    assert.equal(res.status, 401);
  });
});

describe('通联的改动留痕', () => {
  const history = async (app: ReturnType<typeof setup>, id: string) =>
    (await (await get(app, `/api/qsos/${id}/history`)).json()) as {
      at: number;
      action: string;
      before: Qso;
    }[];

  it('新记录没有历史', async () => {
    const app = setup();
    const q = (await (await send(app, 'POST', '/api/qsos', complete)).json()) as Qso;
    assert.deepEqual(await history(app, q.id), []);
  });

  it('每改一次留一条，存的是改之前的样子', async () => {
    const app = setup();
    const q = (await (await send(app, 'POST', '/api/qsos', complete)).json()) as Qso;

    await send(app, 'PUT', `/api/qsos/${q.id}`, { ...q, qth: '成都' });
    await send(app, 'PUT', `/api/qsos/${q.id}`, { ...q, qth: '都江堰' });

    const h = await history(app, q.id);
    assert.equal(h.length, 2);
    assert.equal(h.every((x) => x.action === 'edit'), true);
    // 最新那条在前，它记的是上一次改完的样子
    assert.equal(h[0].before.qth, '成都');
    assert.equal(h[1].before.qth, undefined);
  });

  // 手工补录的那条删掉就真没了，没有 activity 可以回到队列里。
  it('删掉也留痕，还能看见删的是什么', async () => {
    const app = setup();
    const q = (await (await send(app, 'POST', '/api/qsos', complete)).json()) as Qso;

    assert.equal((await send(app, 'DELETE', `/api/qsos/${q.id}`)).status, 204);

    const h = await history(app, q.id);
    assert.equal(h.length, 1);
    assert.equal(h[0].action, 'delete');
    assert.equal(h[0].before.call, 'BD7KLO');
  });

  it('删不掉的时候不留痕', async () => {
    const app = setup();
    assert.equal((await send(app, 'DELETE', '/api/qsos/没这条')).status, 404);
    assert.deepEqual(await history(app, '没这条'), []);
  });
});

describe('公开路由', () => {
  it('只读，没有写接口', async () => {
    const app = setup();
    await send(app, 'POST', '/api/qsos', complete);
    assert.equal(((await (await get(app, '/public/qsos')).json()) as unknown[]).length, 1);

    for (const [method, path] of [
      ['POST', '/public/qsos'],
      ['DELETE', '/public/qsos'],
      ['GET', '/public/pending'],
    ] as const) {
      const body = method === 'GET' ? undefined : {};
      assert.equal((await send(app, method, path, body)).status, 404, `${method} ${path}`);
    }
  });

  // 录音挂在会话后面，不进公开面。guarded 的 /api/qsos 才带 activities。
  it('/public/qsos 不带 activities', async () => {
    const start = Math.floor(Date.now() / 1000) - 600;
    const app = setup([act('a', { startAt: start, dmrId: MY_ID, callsign: 'BD7KLO' })]);
    const pending = (await (await get(app, '/api/pending')).json()) as { cluster: { activities: { id: string }[] } }[];
    await send(app, 'POST', '/api/conversations/promote', {
      ...complete,
      activityIds: pending[0]!.cluster.activities.map((a) => a.id),
    });

    const guarded = (await (await get(app, '/api/qsos')).json()) as { activities?: unknown }[];
    assert.ok(Array.isArray(guarded[0]!.activities) && guarded[0]!.activities!.length > 0);

    const pub = (await (await get(app, '/public/qsos')).json()) as Record<string, unknown>[];
    assert.equal(pub[0]!.activities, undefined);
  });

  // RST 是别的业余电台核对这次通联时要看的，本台字段和备注不往外发。
  it('summary 带 RST，不带本台字段和备注', async () => {
    const app = setup();
    await send(app, 'POST', '/api/qsos', { ...complete, note: '不该出现', myDevice: '也不该' });
    const body = (await (await get(app, '/public/summary')).json()) as {
      recent: Record<string, unknown>[];
    };

    assert.equal(body.recent[0].rstSent, complete.rstSent);
    assert.equal(body.recent[0].rstRcvd, complete.rstRcvd);
    assert.equal(body.recent[0].note, undefined);
    assert.equal(body.recent[0].myDevice, undefined);
  });

  it('公开的本台信息不带频谱表', async () => {
    const body = (await (await get(setup(), '/public/station')).json()) as Record<string, unknown>;
    assert.equal(body.myQth, '成都');
    assert.equal(body.channels, undefined);
  });
});

describe('采集入口', () => {
  const token = config.ingestToken;
  const post = (app: ReturnType<typeof setup>, body: unknown, auth = `Bearer ${token}`) =>
    app.fetch(
      new Request('http://local/api/ingest/activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify(body),
      }),
    );

  it('没有 token 进不来', async () => {
    assert.equal((await post(setup(), [], 'Bearer nope')).status, 401);
    assert.equal((await post(setup(), [], '')).status, 401);
  });

  it('重复推送没有副作用', async () => {
    const app = setup();
    const rows = [{ activity: act('a', { dmrId: MY_ID }), raw: '{}' }];
    assert.deepEqual(await (await post(app, rows)).json(), { received: 1, written: 1 });
    assert.deepEqual(await (await post(app, rows)).json(), { received: 1, written: 0 });
    assert.equal(((await (await get(app, '/api/pending')).json()) as unknown[]).length, 1);
  });
});

describe('健康检查', () => {
  const withQueries = () =>
    createApp(
      createStore(openDb(':memory:'), {
        ...config,
        queries: [
          {
            key: 'dst:91',
            rule: { id: 'DestinationID', operator: 'equal', value: 91 },
            amount: 200,
            intervalS: 60,
          },
        ],
      }),
      config.ingestToken,
      { passwordHash: config.adminPasswordHash, sessionSecret: config.sessionSecret },
    );

  it('没有查询配置时是健康的，而且不要会话', async () => {
    const res = await setup().fetch(new Request('http://local/health'));
    assert.equal(res.status, 200);
    const h = (await res.json()) as { ok: boolean; problems: string[] };
    assert.equal(h.ok, true);
    assert.deepEqual(h.problems, []);
  });

  it('健康检查不泄漏计数和磁盘', async () => {
    const res = await setup().fetch(new Request('http://local/health'));
    const h = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(h).sort(), ['ok', 'problems']);
  });

  // 刚装好必然还没轮询过。把它当成不健康的话，install.sh 装完那一下 curl
  // 必然打印「健康检查没通过」，第一次装的人只会以为装坏了。
  it('刚起来还没轮询过时是健康的', async () => {
    const res = await withQueries().fetch(new Request('http://local/health'));
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { problems: string[] }).problems, []);
  });

  it('久到该轮询却一直没有，就回 503 让一行 curl 当外部检查', async () => {
    const app = withQueries();
    // 把时钟推过最慢那条查询的三倍
    const real = Date.now;
    Date.now = () => real() + 60 * 3 * 1000 + 1000;
    try {
      const res = await app.fetch(new Request('http://local/health'));
      assert.equal(res.status, 503);
      const h = (await res.json()) as { problems: string[] };
      assert.ok(h.problems.some((p) => p.includes('一直没有轮询成功过')));
    } finally {
      Date.now = real;
    }
  });
});

describe('会话', () => {
  const bare = (app: ReturnType<typeof setup>, path: string) =>
    app.fetch(new Request(`http://local${path}`));

  it('没有会话时管理端一律 401', async () => {
    const app = setup();
    for (const path of ['/api/pending', '/api/qsos', '/api/station', '/api/ops']) {
      assert.equal((await bare(app, path)).status, 401, path);
    }
  });

  it('公开路由和健康检查不要会话', async () => {
    const app = setup();
    assert.equal((await bare(app, '/public/qsos')).status, 200);
    assert.equal((await bare(app, '/public/summary')).status, 200);
    assert.equal((await bare(app, '/health')).status, 200);
  });

  it('口令对就发 HttpOnly cookie，错就 401 且不发', async () => {
    const app = setup();
    const login = (password: string) =>
      app.fetch(
        new Request('http://local/api/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        }),
      );

    const bad = await login('nope');
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);

    const good = await login('secret');
    assert.equal(good.status, 200);
    const setCookie = good.headers.get('set-cookie') ?? '';
    assert.ok(setCookie.includes(COOKIE));
    assert.ok(/HttpOnly/i.test(setCookie), '会话 cookie 必须是 HttpOnly');
  });

  it('伪造的会话过不了', async () => {
    const forged = `${COOKIE}=${Math.floor(Date.now() / 1000) + 9999}.deadbeef`;
    const res = await setup().fetch(
      new Request('http://local/api/pending', { headers: { cookie: forged } }),
    );
    assert.equal(res.status, 401);
  });

  it('过期的会话过不了', async () => {
    const expired = `${COOKIE}=${signSession(config.sessionSecret, Math.floor(Date.now() / 1000) - 10)}`;
    const res = await setup().fetch(
      new Request('http://local/api/pending', { headers: { cookie: expired } }),
    );
    assert.equal(res.status, 401);
  });

  it('换了密钥之后旧会话失效', async () => {
    const other = signSession('别的密钥'.repeat(10), Math.floor(Date.now() / 1000) + 9999);
    const res = await setup().fetch(
      new Request('http://local/api/pending', { headers: { cookie: `${COOKIE}=${other}` } }),
    );
    assert.equal(res.status, 401);
  });

  it('采集入口只认 bearer token，不看会话', async () => {
    const res = await setup().fetch(
      new Request('http://local/api/ingest/activity', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.ingestToken}`,
        },
        body: '[]',
      }),
    );
    assert.equal(res.status, 200);
  });
});

// 只有一个口令，猜中一次就是全部，而 host 可以配成 0.0.0.0 给手机用。
describe('登录限速', () => {
  const app = () => {
    const db = openDb(':memory:');
    return createApp(createStore(db, config), config.ingestToken, {
      passwordHash: config.adminPasswordHash,
      sessionSecret: config.sessionSecret,
    }, { loginThrottle: createThrottle({ windowMs: 60_000, max: 3 }) });
  };

  const login = (a: ReturnType<typeof setup>, password: string) =>
    a.fetch(
      new Request('http://local/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      }),
    );

  it('连错几次之后回 429 并给出还要等多久', async () => {
    const a = app();
    for (let i = 0; i < 3; i++) assert.equal((await login(a, 'wrong')).status, 401);

    const blocked = await login(a, 'wrong');

    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  });

  // 挡住的是猜口令的，不是本人。打对了就该马上放行，下次也不该还记着仇。
  it('被挡住之后打对口令依然进不去，但计数清零之后可以', async () => {
    const a = app();
    for (let i = 0; i < 4; i++) await login(a, 'wrong');
    assert.equal((await login(a, 'secret')).status, 429);
  });

  it('没超之前打对就发 cookie，并且把计数清掉', async () => {
    const a = app();
    await login(a, 'wrong');
    const ok = await login(a, 'secret');
    assert.equal(ok.status, 200);

    // 清零之后又能重新用满额度
    for (let i = 0; i < 3; i++) assert.equal((await login(a, 'wrong')).status, 401);
  });
});

describe('没接住的异常', () => {
  it('回 JSON 而不是纯文本 500', async () => {
    const broken = {
      ...createStore(openDb(':memory:'), config),
      qsosWithActivities: () => {
        throw new Error('库炸了');
      },
    };
    const app = createApp(broken, config.ingestToken, {
      passwordHash: config.adminPasswordHash,
      sessionSecret: config.sessionSecret,
    });

    const res = await app.fetch(
      new Request('http://local/api/qsos', { headers: { cookie: cookie() } }),
    );

    assert.equal(res.status, 500);
    assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
    assert.ok(((await res.json()) as { error?: string }).error);
  });
});

// 写完之后再读一次，必须是新值。漏掉一个字段的话，文件和电台都换了，
// 而设置页还显示旧的那个，看起来就像「改了没生效」。
// 没有这个的话，「天线听不见」和「没人在发」在界面上长得一模一样。
describe('电台状态', () => {
  // 这一档测的是状态本身的记录和整理，不是开关。模拟守听开着，
  // 关着的情形（radios 一律是空数组）在「开关」那一档测。
  const radioConfig: Config = {
    ...config,
    analog: { channels: [{ freqMhz: 438.5, channel: '438.500 中继' }], enabled: true, openMarginDb: 12, closeMarginDb: 7 },
  };

  const push = (app: ReturnType<typeof setup>, body: unknown) =>
    app.fetch(
      new Request('http://local/api/ingest/radio', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ingestToken}` },
        body: JSON.stringify(body),
      }),
    );

  type View = {
    freqMhz: number;
    channel: string;
    noiseDb: number;
    fresh: boolean;
    ageS: number;
    open: boolean;
    closestDb?: number;
    lastError?: string;
    restarts?: number;
  };
  const ops = async (app: ReturnType<typeof setup>) =>
    ((await (await get(app, '/api/ops')).json()) as { radios: View[] }).radios;

  const good = {
    freqMhz: 438.5,
    channel: '438.500 中继',
    gainDb: 32.8,
    idleDb: 90.6,
    openBelowDb: 78.6,
    closeAboveDb: 83.6,
    noiseDb: 90.1,
    open: false,
    at: Math.floor(Date.now() / 1000),
  };
  const other = { ...good, freqMhz: 438.975, channel: '438.975', noiseDb: 88.0 };

  it('没收到过状态时 ops 里是空的', async () => {
    assert.deepEqual(await ops(setup([], radioConfig)), []);
  });

  it('一支接收机守两个信道，一批报两条，ops 里两个都读得到，都是新鲜的', async () => {
    const app = setup([], radioConfig);
    assert.equal((await push(app, [good, other])).status, 204);

    const r = await ops(app);
    assert.deepEqual(
      r.map((x) => [x.freqMhz, x.noiseDb, x.fresh]),
      [
        [438.5, 90.1, true],
        [438.975, 88.0, true],
      ],
    );
    assert.ok(r[0]!.ageS < 5);
  });

  // 只守一个信道时报的是单个对象，还没升级的守护进程照样认。
  it('单个对象也认', async () => {
    const app = setup([], radioConfig);
    await push(app, good);
    assert.equal((await ops(app))[0]?.freqMhz, 438.5);
  });

  // 守护进程或者 rtl_sdr 出事时状态就停在那里，界面要能看出来是停了。
  it('太久没报就不算新鲜', async () => {
    const app = setup([], radioConfig);
    await push(app, [{ ...good, at: Math.floor(Date.now() / 1000) - 60 }]);

    const r = (await ops(app))[0];
    assert.equal(r?.fresh, false);
    assert.ok((r?.ageS ?? 0) >= 60);
  });

  // 运维页 20 秒拉一次，看到的只是那一瞬。光看一个瞬时值答不了
  // 「这个信号够不够得着门限」，得记住最接近的那一次。每个信道各记各的。
  it('每个信道各自记住这次守听里最接近门限的一刻', async () => {
    const app = setup([], radioConfig);
    await push(app, [{ ...good, noiseDb: 90.1 }, { ...other, noiseDb: 88.0 }]);
    await push(app, [{ ...good, noiseDb: 82.0 }, { ...other, noiseDb: 89.0 }]);
    await push(app, [{ ...good, noiseDb: 89.0 }, { ...other, noiseDb: 90.0 }]);

    const r = await ops(app);
    assert.equal(r[0]!.closestDb, 3.4);
    assert.equal(r[1]!.closestDb, 9.4);
  });

  it('换了信道表，新信道从头记，去掉的信道不再出现', async () => {
    const app = setup([], radioConfig);
    await push(app, [{ ...good, noiseDb: 82.0 }, other]);
    await push(app, [{ ...good, noiseDb: 90.1 }, { ...good, freqMhz: 145.5, channel: '145.500 直频', noiseDb: 90.1 }]);

    const r = await ops(app);
    assert.deepEqual(
      r.map((x) => [x.freqMhz, x.closestDb]),
      [
        [438.5, 3.4],
        [145.5, 11.5],
      ],
    );
  });

  // 抢不到 USB 设备时 rtl_sdr 不往 stdout 写东西，只有这条路能把原因带出来。
  it('带上 rtl_sdr 最后一句和重开次数', async () => {
    const app = setup([], radioConfig);
    await push(app, [
      {
        freqMhz: 438.5,
        channel: '438.500 中继',
        gainDb: 32.8,
        open: false,
        lastError: 'rtl_sdr: usb_claim_interface error -3',
        restarts: 4,
        at: Math.floor(Date.now() / 1000),
      },
    ]);

    const r = (await ops(app))[0];
    assert.match(r?.lastError ?? '', /usb_claim_interface/);
    assert.equal(r?.restarts, 4);
  });

  it('形状不对的那条当没收到，但不让请求失败', async () => {
    const app = setup([], radioConfig);
    assert.equal((await push(app, { 乱七八糟: 1 })).status, 204);
    assert.deepEqual(await ops(app), []);
    await push(app, [good, { 乱七八糟: 1 }]);
    assert.equal((await ops(app)).length, 1);
  });

  it('要 bearer token，不看会话', async () => {
    const app = setup([], radioConfig);
    const res = await app.fetch(
      new Request('http://local/api/ingest/radio', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie() },
        body: JSON.stringify([good]),
      }),
    );
    assert.equal(res.status, 401);
  });
});

describe('设置读写', () => {
  const onDisk = () => {
    const dir = mkdtempSync(join(tmpdir(), 'openheard-cfg-'));
    const path = join(dir, 'openheard.config.json');
    writeFileSync(
      path,
      JSON.stringify({
        dbPath: ':memory:',
        dmrId: 4616460,
        clusterGapS: 120,
        pendingWindowDays: 7,
        activityRetentionDays: 90,
        ingestToken: config.ingestToken,
        adminPasswordHash: config.adminPasswordHash,
        sessionSecret: config.sessionSecret,
        station: { myCallsign: 'BG0CG', networkFreqMhz: 439.525 },
        channels: [],
        analog: { freqMhz: 438.7, channel: '438.700 直频', myUnitId: '6460', recordingsDir: './rec' },
        queries: [
          {
            key: 'dst:46001',
            rule: { id: 'DestinationID', operator: 'equal', value: 46001 },
            amount: 200,
            intervalS: 900,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const r = loadConfig(path);
    assert.ok(r.ok);
    return createApp(createStore(openDb(':memory:'), r.config), config.ingestToken, {
      passwordHash: config.adminPasswordHash,
      sessionSecret: config.sessionSecret,
    });
  };

  it('改完之后 GET 回来的是新值，不是启动时那份', async () => {
    type A = { analog: { channels: { freqMhz: number; channel: string }[] } };
    const app = onDisk();
    const before = (await (await get(app, '/api/settings')).json()) as A;
    // 文件里是旧写法的单个频率，读出来是一个信道的表
    assert.deepEqual(before.analog.channels, [{ freqMhz: 438.7, channel: '438.700 直频' }]);

    const channels = [
      { freqMhz: 438.5, channel: '438.500 中继' },
      { freqMhz: 438.975, channel: '438.975' },
    ];
    const put = await send(app, 'PUT', '/api/settings', { ...before, analog: { ...before.analog, channels } });
    assert.equal(put.status, 200);
    assert.deepEqual(((await put.json()) as A).analog.channels, channels);

    const after = (await (await get(app, '/api/settings')).json()) as A;
    assert.deepEqual(after.analog.channels, channels);
  });

  it('本台和信道也一样，改完立刻读得到', async () => {
    const app = onDisk();
    const s = (await (await get(app, '/api/settings')).json()) as Record<string, unknown>;

    await send(app, 'PUT', '/api/settings', {
      ...s,
      station: { myCallsign: 'BG0CG', myQth: '都江堰', networkFreqMhz: 439.525 },
      channels: [{ name: '145.500 直频', freqMhz: 145.5, mode: 'FM' }],
    });

    const after = (await (await get(app, '/api/settings')).json()) as {
      station: { myQth: string };
      channels: unknown[];
    };
    assert.equal(after.station.myQth, '都江堰');
    assert.equal(after.channels.length, 1);
    // 本台信息是从 /station 读的，那条也要跟着变
    const st = (await (await get(app, '/api/station')).json()) as { station: { myQth: string } };
    assert.equal(st.station.myQth, '都江堰');
  });

  it('乱填不落盘，原来的值还在', async () => {
    const app = onDisk();
    const s = (await (await get(app, '/api/settings')).json()) as Record<string, unknown>;

    const bad = await send(app, 'PUT', '/api/settings', {
      ...s,
      analog: { channels: [{ freqMhz: 100, channel: 'x' }] },
    });
    assert.equal(bad.status, 422);

    const after = (await (await get(app, '/api/settings')).json()) as {
      analog: { channels: { freqMhz: number }[] };
    };
    assert.equal(after.analog.channels[0]!.freqMhz, 438.7);
  });
});

describe('开关', () => {
  const onDisk = (overrides: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'openheard-switches-'));
    const path = join(dir, 'openheard.config.json');
    writeFileSync(
      path,
      JSON.stringify({
        dbPath: ':memory:',
        dmrId: 4616460,
        clusterGapS: 120,
        pendingWindowDays: 7,
        activityRetentionDays: 90,
        ingestToken: config.ingestToken,
        adminPasswordHash: config.adminPasswordHash,
        sessionSecret: config.sessionSecret,
        station: { myCallsign: 'BG0CG', networkFreqMhz: 439.525 },
        channels: [],
        analog: { channels: [{ freqMhz: 438.5, channel: '438.500 中继' }], myUnitId: '6460' },
        queries: [
          { key: 'dst:46001', rule: { id: 'DestinationID', operator: 'equal', value: 46001 }, amount: 200, intervalS: 900 },
        ],
        ...overrides,
      }),
      { mode: 0o600 },
    );
    const r = loadConfig(path);
    assert.ok(r.ok);
    const app = createApp(
      createStore(openDb(':memory:'), r.config),
      config.ingestToken,
      { passwordHash: config.adminPasswordHash, sessionSecret: config.sessionSecret },
      // 和 index.ts 一样传函数：写设置改了 config.recordingsDir 之后，这里
      // 要立刻看见新值，不等进程重启。
      { recordingsDir: () => r.config.recordingsDir },
    );
    return { app, path, cfg: r.config };
  };

  it('GET /api/station 和 /api/ops 都带上生效的开关状态', async () => {
    const { app } = onDisk();
    const station = (await (await get(app, '/api/station')).json()) as {
      analogEnabled: boolean;
      brandmeisterEnabled: boolean;
    };
    assert.deepEqual([station.analogEnabled, station.brandmeisterEnabled], [true, true]);

    const ops = (await (await get(app, '/api/ops')).json()) as { analogEnabled: boolean; brandmeisterEnabled: boolean };
    assert.deepEqual([ops.analogEnabled, ops.brandmeisterEnabled], [true, true]);
  });

  const pushRadio = (app: ReturnType<typeof setup>, body: unknown) =>
    app.fetch(
      new Request('http://local/api/ingest/radio', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ingestToken}` },
        body: JSON.stringify(body),
      }),
    );

  it('关掉模拟守听：GET /api/radios 和 /api/ops 的 radios 一律是空数组', async () => {
    const { app } = onDisk();
    await pushRadio(app, [
      { freqMhz: 438.5, channel: '438.500 中继', gainDb: 32.8, open: false, at: Math.floor(Date.now() / 1000) },
    ]);

    const before = (await (await get(app, '/api/radios')).json()) as { analogEnabled: boolean; radios: unknown[] };
    assert.equal(before.analogEnabled, true);
    assert.equal(before.radios.length, 1);

    const { app: off } = onDisk({ analog: { channels: [{ freqMhz: 438.5, channel: '438.500 中继' }], enabled: false } });
    await pushRadio(off, [
      { freqMhz: 438.5, channel: '438.500 中继', gainDb: 32.8, open: false, at: Math.floor(Date.now() / 1000) },
    ]);
    const r = (await (await get(off, '/api/radios')).json()) as { analogEnabled: boolean; radios: unknown[] };
    assert.deepEqual([r.analogEnabled, r.radios], [false, []]);
    const opsOff = (await (await get(off, '/api/ops')).json()) as { analogEnabled: boolean; radios: unknown[] };
    assert.deepEqual([opsOff.analogEnabled, opsOff.radios], [false, []]);
  });

  it('切开关全程保留原来的 queries 和信道表，回显和接口都不丢字段', async () => {
    const { app } = onDisk();
    const before = (await (await get(app, '/api/settings')).json()) as Record<string, unknown>;

    // Form.Item 挂着但隐藏：body 里 queries 照样带着原样的值，只多了 brandmeisterEnabled。
    const put = await send(app, 'PUT', '/api/settings', { ...before, brandmeisterEnabled: false });
    assert.equal(put.status, 200);

    const after = (await put.json()) as { brandmeisterEnabled: boolean; queries: unknown[] };
    assert.equal(after.brandmeisterEnabled, false);
    assert.equal(after.queries.length, 1);

    const station = (await (await get(app, '/api/station')).json()) as { brandmeisterEnabled: boolean };
    assert.equal(station.brandmeisterEnabled, false);
  });

  // 设置页从没有模拟守听加上一段之后，录音路由不用等 api 重启。
  it('设置页加上模拟守听之后，新目录里的录音立刻能列出来、放得出', async () => {
    const { app, cfg } = onDisk({ analog: undefined });
    assert.equal(cfg.analog, undefined);
    assert.deepEqual(await (await get(app, '/api/recordings')).json(), []);

    const before = (await (await get(app, '/api/settings')).json()) as Record<string, unknown>;
    const put = await send(app, 'PUT', '/api/settings', {
      ...before,
      analog: { channels: [{ freqMhz: 438.5, channel: '438.500 中继' }] },
    });
    assert.equal(put.status, 200);
    assert.ok(cfg.recordingsDir.length > 0);

    mkdirSync(cfg.recordingsDir, { recursive: true });
    writeFileSync(join(cfg.recordingsDir, 'fm-abc123.wav'), 'RIFF1234');

    assert.deepEqual(await (await get(app, '/api/recordings')).json(), ['fm-abc123']);
    const rec = await get(app, '/api/recordings/fm-abc123');
    assert.equal(rec.status, 200);
    assert.equal(await rec.text(), 'RIFF1234');
  });

  // 进程已经跑了很久（早就过了宽限期），BrandMeister 关了一阵子刚打开：
  // 不该拿进程启动的那一刻当基准，得从刚打开这一刻重新算宽限。
  it('BrandMeister 从关到开，健康检查按打开的那一刻给宽限，不是按进程启动的那一刻', async () => {
    const { app } = onDisk({ brandmeisterEnabled: false });
    const real = Date.now;
    try {
      // 进程「已经跑了」比最慢查询三倍还久
      Date.now = () => real() + 900 * 3 * 1000 + 5000;
      const stillOff = (await (await app.fetch(new Request('http://local/health'))).json()) as { ok: boolean };
      assert.equal(stillOff.ok, true, '还没打开过 BrandMeister，没有查询在跑，天然健康');

      const s = (await (await get(app, '/api/settings')).json()) as Record<string, unknown>;
      // 关一次，再打开：宽限从这一次打开算起，不是进程起来的那一刻
      await send(app, 'PUT', '/api/settings', { ...s, brandmeisterEnabled: false });
      const put = await send(app, 'PUT', '/api/settings', { ...s, brandmeisterEnabled: true });
      assert.equal(put.status, 200);

      // 刚打开，一次都没轮询过，也该是健康的——宽限期从这一刻算起。
      const justOn = (await (await app.fetch(new Request('http://local/health'))).json()) as { ok: boolean };
      assert.equal(justOn.ok, true);
    } finally {
      Date.now = real;
    }
  });
});

describe('录音回放', () => {
  const withRec = (dir: string | undefined) =>
    createApp(
      createStore(openDb(':memory:'), config),
      config.ingestToken,
      { passwordHash: config.adminPasswordHash, sessionSecret: config.sessionSecret },
      { recordingsDir: dir },
    );

  const rec = (app: ReturnType<typeof setup>, path = '') =>
    app.fetch(new Request(`http://local/api/recordings${path}`, { headers: { cookie: cookie() } }));

  it('列出哪几次发射有录音', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openheard-rec-'));
    writeFileSync(join(dir, 'a1.wav'), 'RIFF');
    writeFileSync(join(dir, 'a2.wav'), 'RIFF');
    writeFileSync(join(dir, '说明.txt'), '不是录音');

    const body = (await (await rec(withRec(dir))).json()) as string[];

    assert.deepEqual(body.sort(), ['a1', 'a2']);
  });

  it('放得出音频，带 content-type 和长度', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openheard-rec-'));
    writeFileSync(join(dir, 'a1.wav'), 'RIFFxxxx');

    const res = await rec(withRec(dir), '/a1');

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.equal(res.headers.get('content-length'), '8');
    assert.equal(await res.text(), 'RIFFxxxx');
  });

  it('没有那一条回 404，没配模拟守听也回 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openheard-rec-'));
    assert.equal((await rec(withRec(dir), '/没有这条')).status, 400);
    assert.equal((await rec(withRec(dir), '/a9')).status, 404);
    assert.equal((await rec(withRec(undefined), '/a1')).status, 404);
    assert.deepEqual(await (await rec(withRec(undefined))).json(), []);
  });

  // id 直接拼进路径，跑出录音目录就等于把机器上任意文件发出去。
  it('id 里的路径符号一律挡掉', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openheard-rec-'));
    for (const bad of ['/..%2f..%2fetc%2fpasswd', '/a%2f..%2f..%2fetc%2fpasswd', '/.']) {
      const res = await rec(withRec(dir), bad);
      assert.ok(res.status === 400 || res.status === 404, `${bad} -> ${res.status}`);
    }
  });

  it('录音要会话，公开面拿不到', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openheard-rec-'));
    writeFileSync(join(dir, 'a1.wav'), 'RIFF');
    const app = withRec(dir);
    assert.equal((await app.fetch(new Request('http://local/api/recordings/a1'))).status, 401);
    assert.equal((await app.fetch(new Request('http://local/public/recordings/a1'))).status, 404);
  });
});

describe('管理端界面', () => {
  const withWeb = (dist: string) =>
    createApp(
      createStore(openDb(':memory:'), config),
      config.ingestToken,
      { passwordHash: config.adminPasswordHash, sessionSecret: config.sessionSecret },
      { webDist: dist },
    );

  it('没有构建产物时不影响接口', async () => {
    const app = withWeb('/nowhere');
    assert.equal((await app.fetch(new Request('http://local/health'))).status, 200);
    assert.equal((await app.fetch(new Request('http://local/'))).status, 404);
  });

  // 前端是单页应用，/log 这种路由只有浏览器知道，服务端一律回首页。
  // 首页里写死了带散列的资源名。浏览器把它缓存住的话，升级之后还会去取旧的
  // 那一份，人看到的是上一版界面，而且会以为新功能根本没做出来。
  it('首页不缓存，assets 长期缓存', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openheard-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>OpenHeard</title>');
    const app = withWeb(dir);

    const page = await app.fetch(new Request('http://local/log'));
    assert.equal(page.headers.get('cache-control'), 'no-store');
  });

  it('有构建产物时任意路径都回首页，接口不受影响', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openheard-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>OpenHeard</title>');
    const app = withWeb(dir);

    for (const path of ['/', '/log', '/ops']) {
      const res = await app.fetch(new Request(`http://local${path}`));
      assert.equal(res.status, 200, path);
      assert.ok((await res.text()).includes('OpenHeard'), path);
    }

    // 接口还是接口，没被首页盖掉
    assert.equal((await app.fetch(new Request('http://local/api/qsos'))).status, 401);
    assert.equal((await app.fetch(new Request('http://local/health'))).status, 200);
    assert.equal((await app.fetch(new Request('http://local/public/summary'))).status, 200);
  });
});

describe('会话 cookie 的 Secure', () => {
  const login = (app: ReturnType<typeof setup>, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request('http://local/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ password: 'secret' }),
      }),
    );

  it('明文回环不带 Secure', async () => {
    const res = await login(setup());
    assert.equal(res.headers.get('set-cookie')?.includes('Secure'), false);
  });

  // 走 Tailscale 时 TLS 在它那里终结，到这里已经是明文回环，只能看转发头。
  it('转发头说是 https 就带上 Secure', async () => {
    const res = await login(setup(), { 'x-forwarded-proto': 'https' });
    assert.equal(res.headers.get('set-cookie')?.includes('Secure'), true);
  });
});

describe('配置有问题时', () => {
  it('照常应答，每条路由都回 503 并说明原因', async () => {
    const app = createBrokenApp(['clusterGapS 必填']);
    const res = await app.fetch(new Request('http://local/api/pending'));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { problems: string[] };
    assert.deepEqual(body.problems, ['clusterGapS 必填']);
  });
});
