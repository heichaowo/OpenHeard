import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
};

const act = (id: string, over: Partial<Activity> = {}): Activity => ({
  id,
  origin: 'brandmeister',
  startAt: Math.floor(Date.now() / 1000) - 600,
  durationS: 5,
  mine: false,
  ...over,
});

function setup(activities: Activity[] = []) {
  const db = openDb(':memory:');
  if (activities.length > 0) {
    insertActivities(db, activities.map((a) => ({ activity: a, raw: '{}' })), 1);
  }
  return createApp(createStore(db, config), config.ingestToken, {
    passwordHash: config.adminPasswordHash,
    sessionSecret: config.sessionSecret,
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

describe('提升', () => {
  const two = () => {
    const t = Math.floor(Date.now() / 1000) - 600;
    return setup([
      act('a', { startAt: t, dmrId: MY_ID, callsign: 'BG0CG' }),
      act('b', { startAt: t + 30, dmrId: 777, callsign: 'BD7KLO' }),
    ]);
  };

  it('整段一起离开队列，并出现在日志里', async () => {
    const app = two();
    const res = await send(app, 'POST', '/api/pending/a/promote', { ...complete, call: 'BD7KLO' });
    assert.equal(res.status, 200);
    const qso = (await res.json()) as Qso;
    assert.ok(qso.id);
    assert.equal(qso.clusterId, 'a');

    assert.deepEqual(await (await get(app, '/api/pending')).json(), []);
    assert.equal(((await (await get(app, '/api/qsos')).json()) as unknown[]).length, 1);
  });

  it('缺字段回 422 并说清缺什么', async () => {
    const res = await send(app422(), 'POST', '/api/pending/a/promote', { startAt: 1 });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { missing: string[] };
    assert.ok(body.missing.includes('call'));
  });

  it('段的 id 对不上回 409', async () => {
    const res = await send(two(), 'POST', '/api/pending/nope/promote', complete);
    assert.equal(res.status, 409);
  });

  function app422() {
    const t = Math.floor(Date.now() / 1000) - 600;
    return setup([act('a', { startAt: t, dmrId: MY_ID })]);
  }
});

describe('忽略', () => {
  it('整段离开队列，也不产生通联', async () => {
    const t = Math.floor(Date.now() / 1000) - 600;
    const app = setup([act('a', { startAt: t, dmrId: MY_ID }), act('b', { startAt: t + 30 })]);
    const res = await send(app, 'DELETE', '/api/pending/a');
    assert.equal(res.status, 204);
    assert.deepEqual(await (await get(app, '/api/pending')).json(), []);
    assert.deepEqual(await (await get(app, '/api/qsos')).json(), []);
  });
});

// 一条一条调的话，每忽略一段就重新聚类一次，剩下那些段的 id 会变，后面全 409。
describe('一次忽略好几段', () => {
  const start = Math.floor(Date.now() / 1000) - 3600;
  const three = () =>
    setup([
      act('a1', { dmrId: MY_ID, startAt: start, talkgroup: 46001 }),
      act('a2', { dmrId: MY_ID, startAt: start + 600, talkgroup: 46001 }),
      act('a3', { dmrId: MY_ID, startAt: start + 1200, talkgroup: 46001 }),
    ]);

  it('三段一次忽略掉，队列空了', async () => {
    const app = three();
    const before = (await (await get(app, '/api/pending')).json()) as { cluster: { id: string } }[];
    assert.equal(before.length, 3);

    const res = await send(app, 'POST', '/api/pending/ignore', {
      clusterIds: before.map((p) => p.cluster.id),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ignored: 3, missing: [] });
    assert.equal(((await (await get(app, '/api/pending')).json()) as unknown[]).length, 0);
  });

  it('只忽略给到的那几段，别的留着', async () => {
    const app = three();
    const before = (await (await get(app, '/api/pending')).json()) as { cluster: { id: string } }[];

    await send(app, 'POST', '/api/pending/ignore', { clusterIds: [before[0].cluster.id] });

    assert.equal(((await (await get(app, '/api/pending')).json()) as unknown[]).length, 2);
  });

  it('认不出来的 id 单独报出来，不影响别的', async () => {
    const app = three();
    const before = (await (await get(app, '/api/pending')).json()) as { cluster: { id: string } }[];

    const res = await send(app, 'POST', '/api/pending/ignore', {
      clusterIds: [before[0].cluster.id, '不存在'],
    });

    assert.deepEqual(await res.json(), { ignored: 1, missing: ['不存在'] });
  });

  it('传的不是字符串数组就 422', async () => {
    assert.equal((await send(three(), 'POST', '/api/pending/ignore', { clusterIds: 'x' })).status, 422);
    assert.equal((await send(three(), 'POST', '/api/pending/ignore', { clusterIds: [1] })).status, 422);
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
    const pending = (await (await get(app, '/api/pending')).json()) as { cluster: { id: string } }[];
    const promoted = (await (
      await send(app, 'POST', `/api/pending/${pending[0].cluster.id}/promote`, {
        ...complete,
        startAt: start,
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
      qsos: () => {
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
  const push = (app: ReturnType<typeof setup>, body: unknown) =>
    app.fetch(
      new Request('http://local/api/ingest/radio', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ingestToken}` },
        body: JSON.stringify(body),
      }),
    );

  const ops = async (app: ReturnType<typeof setup>) =>
    (await (await get(app, '/api/ops')).json()) as {
      radio?: { freqMhz: number; noiseDb: number; fresh: boolean; ageS: number; open: boolean };
    };

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

  it('没收到过状态时 ops 里就没有这一项', async () => {
    assert.equal((await ops(setup())).radio, undefined);
  });

  it('推上来之后 ops 里读得到，并且是新鲜的', async () => {
    const app = setup();
    assert.equal((await push(app, good)).status, 204);

    const r = (await ops(app)).radio;
    assert.equal(r?.freqMhz, 438.5);
    assert.equal(r?.noiseDb, 90.1);
    assert.equal(r?.fresh, true);
    assert.ok((r?.ageS ?? 99) < 5);
  });

  // 守护进程或者 rtl_fm 出事时状态就停在那里，界面要能看出来是停了。
  it('太久没报就不算新鲜', async () => {
    const app = setup();
    await push(app, { ...good, at: Math.floor(Date.now() / 1000) - 60 });

    const r = (await ops(app)).radio;
    assert.equal(r?.fresh, false);
    assert.ok((r?.ageS ?? 0) >= 60);
  });

  // 运维页 20 秒拉一次，看到的只是那一瞬。光看一个瞬时值答不了
  // 「这个信号够不够得着门限」，得记住最接近的那一次。
  it('记住这次守听里最接近门限的一刻', async () => {
    const app = setup();
    await push(app, { ...good, noiseDb: 90.1 }); // 差 11.5
    await push(app, { ...good, noiseDb: 82.0 }); // 差 3.4，最接近
    await push(app, { ...good, noiseDb: 89.0 }); // 差 10.4

    const r = (await ops(app)).radio as { closestDb: number } | undefined;
    assert.ok(r);
    assert.equal(Math.round(r.closestDb * 10) / 10, 3.4);
  });

  it('换了频率就重新记，上个频点的最接近值说明不了这个', async () => {
    const app = setup();
    await push(app, { ...good, noiseDb: 82.0 });
    await push(app, { ...good, freqMhz: 145.5, channel: '145.500 直频', noiseDb: 90.1 });

    const r = (await ops(app)).radio as { closestDb: number } | undefined;
    assert.equal(Math.round((r?.closestDb ?? 0) * 10) / 10, 11.5);
  });

  // 抢不到 USB 设备时 rtl_fm 不往 stdout 写东西，只有这条路能把原因带出来。
  it('带上 rtl_fm 最后一句和重开次数', async () => {
    const app = setup();
    await push(app, {
      freqMhz: 438.5,
      channel: '438.500 中继',
      gainDb: 32.8,
      open: false,
      lastError: 'rtl_fm: usb_claim_interface error -3',
      restarts: 4,
      at: Math.floor(Date.now() / 1000),
    });

    const r = (await ops(app)).radio as { lastError: string; restarts: number } | undefined;
    assert.match(r?.lastError ?? '', /usb_claim_interface/);
    assert.equal(r?.restarts, 4);
  });

  it('形状不对就当没收到，但不让请求失败', async () => {
    const app = setup();
    assert.equal((await push(app, { 乱七八糟: 1 })).status, 204);
    assert.equal((await ops(app)).radio, undefined);
  });

  it('要 bearer token，不看会话', async () => {
    const app = setup();
    const res = await app.fetch(
      new Request('http://local/api/ingest/radio', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie() },
        body: JSON.stringify(good),
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
    const app = onDisk();
    const before = (await (await get(app, '/api/settings')).json()) as {
      analog: { freqMhz: number };
    };
    assert.equal(before.analog.freqMhz, 438.7);

    const put = await send(app, 'PUT', '/api/settings', {
      ...before,
      analog: { ...before.analog, freqMhz: 439.525, channel: '439.525 中继' },
    });
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as { analog: { freqMhz: number } }).analog.freqMhz, 439.525);

    const after = (await (await get(app, '/api/settings')).json()) as {
      analog: { freqMhz: number; channel: string };
    };
    assert.equal(after.analog.freqMhz, 439.525);
    assert.equal(after.analog.channel, '439.525 中继');
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

    const bad = await send(app, 'PUT', '/api/settings', { ...s, analog: { freqMhz: 100, channel: 'x' } });
    assert.equal(bad.status, 422);

    const after = (await (await get(app, '/api/settings')).json()) as { analog: { freqMhz: number } };
    assert.equal(after.analog.freqMhz, 438.7);
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
