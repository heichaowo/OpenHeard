import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp, createBrokenApp } from './app.ts';
import { COOKIE, SESSION_DAYS, hashPassword, signSession } from './auth.ts';
import type { Config } from './config.ts';
import type { Activity, Qso } from './core.ts';
import { insertActivities, openDb } from './db.ts';
import { createStore } from './store.ts';

const MY_ID = 4600123;

const config: Config = {
  dbPath: ':memory:',
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

  it('不健康时回 503，让一行 curl 就能当外部检查', async () => {
    const db = openDb(':memory:');
    const withQuery = {
      ...config,
      queries: [{ key: 'dst:91', rule: { id: 'DestinationID', operator: 'equal', value: 91 }, amount: 200, intervalS: 60 }],
    };
    const app = createApp(createStore(db, withQuery), config.ingestToken, {
      passwordHash: config.adminPasswordHash,
      sessionSecret: config.sessionSecret,
    });
    const res = await app.fetch(new Request('http://local/health'));
    assert.equal(res.status, 503);
    const h = (await res.json()) as { problems: string[] };
    assert.ok(h.problems.some((p) => p.includes('还没有过一次轮询')));
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

describe('配置有问题时', () => {
  it('照常应答，每条路由都回 503 并说明原因', async () => {
    const app = createBrokenApp(['clusterGapS 必填']);
    const res = await app.fetch(new Request('http://local/api/pending'));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { problems: string[] };
    assert.deepEqual(body.problems, ['clusterGapS 必填']);
  });
});
