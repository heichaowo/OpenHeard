import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from './app.ts';
import { COOKIE, SESSION_DAYS, hashPassword, signSession } from './auth.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import type { Activity } from './core.ts';
import { insertActivities, insertQso, openDb, resolveActivities } from './db.ts';
import { createStore } from './store.ts';

const MY_ID = 4616460;
const TOKEN = 'x'.repeat(32);
const SECRET = 's'.repeat(40);
const NOW = Math.floor(Date.now() / 1000);

const baseFile = {
  dbPath: ':memory:',
  dmrId: MY_ID,
  clusterGapS: 120,
  pendingWindowDays: 7,
  activityRetentionDays: 90,
  ingestToken: TOKEN,
  adminPasswordHash: hashPassword('secret'),
  sessionSecret: SECRET,
  station: { myCallsign: 'BG0CG', networkFreqMhz: 439.525 },
  channels: [],
  queries: [{ key: 'dst:46001', rule: { id: 'DestinationID', operator: 'equal', value: 46001 }, amount: 200, intervalS: 900 }],
};

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

/** 真文件、真配置、真路由。设置和代理都要读写配置文件。 */
function make(opts: { rows?: Activity[]; file?: Record<string, unknown>; fetch?: typeof fetch; webDist?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-air-'));
  const path = join(dir, 'openheard.config.json');
  writeFileSync(path, JSON.stringify({ ...baseFile, ...opts.file }, null, 2), { mode: 0o600 });
  const r = loadConfig(path);
  assert.ok(r.ok);
  const config: Config = r.config;
  mkdirSync(config.recordingsDir, { recursive: true });
  const db = openDb(':memory:');
  if (opts.rows) insertActivities(db, opts.rows.map((a) => ({ activity: a, raw: '{}' })), 1);
  for (const a of opts.rows ?? []) if (a.origin === 'sdr-fm') writeFileSync(join(config.recordingsDir, `${a.id}.wav`), 'RIFF');
  const store = createStore(db, config);
  const app = createApp(store, TOKEN, { passwordHash: config.adminPasswordHash, sessionSecret: SECRET }, { fetch: opts.fetch, webDist: opts.webDist });
  return { app, db, store, config, path };
}
type Made = ReturnType<typeof make>;

const cookie = () => `${COOKIE}=${signSession(SECRET, NOW + SESSION_DAYS * 86400)}`;
const req = (app: Made['app'], method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie: cookie() }) =>
  app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const get = (m: Made, path: string) => req(m.app, 'GET', path);
const post = (m: Made, path: string, body: unknown) => req(m.app, 'POST', path, body);
const ingest = (m: Made, method: string, path: string, body?: unknown) =>
  req(m.app, method, path, body, { authorization: `Bearer ${TOKEN}` });
const json = async <T>(res: Response) => (await res.json()) as T;

const t0 = NOW - 3600;
const wavOf = (m: Made, id: string) => existsSync(join(m.config.recordingsDir, `${id}.wav`));
const rowCount = (m: Made, table: string) => (m.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('POST /api/conversations/delete', () => {
  it('删掉发射、识别结果、判定和录音，留墓碑，再推来也不写回', async () => {
    const m = make({ rows: [fm('a', t0, { mine: true }), fm('b', t0 + 30), fm('keep', t0 + 5000)] });
    await ingest(m, 'POST', '/api/ingest/ai', [{ activityId: 'a', hasSpeech: false }]);
    await post(m, '/api/conversations/verdict', { activityIds: ['a'], meaningless: true });

    const res = await post(m, '/api/conversations/delete', { picks: [{ id: 'a', activityIds: ['a', 'b'] }] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: 1, missing: [] });
    assert.deepEqual([rowCount(m, 'activity'), rowCount(m, 'activity_ai'), rowCount(m, 'activity_verdict'), rowCount(m, 'deleted_activity')], [1, 0, 0, 2]);
    assert.deepEqual([wavOf(m, 'a'), wavOf(m, 'b'), wavOf(m, 'keep')], [false, false, true]);

    // 采集再推来：墓碑挡住，written 不算它们
    const again = await ingest(m, 'POST', '/api/ingest/activity', [
      { activity: fm('a', t0, { mine: true }), raw: '{}' },
      { activity: fm('new', t0 + 9000), raw: '{}' },
    ]);
    assert.deepEqual(await again.json(), { received: 2, written: 1 });
    assert.equal(rowCount(m, 'activity'), 2);
  });

  it('已忽略的成员可以删，连它的忽略记录', async () => {
    const m = make({ rows: [fm('a', t0, { mine: true })] });
    await post(m, '/api/conversations/ignore', { picks: [{ id: 'a', activityIds: ['a'] }] });
    assert.equal(rowCount(m, 'resolved_activity'), 1);

    const res = await post(m, '/api/conversations/delete', { picks: [{ id: 'a', activityIds: ['a'] }] });
    assert.deepEqual(await res.json(), { deleted: 1, missing: [] });
    assert.equal(rowCount(m, 'resolved_activity'), 0);
    assert.equal(wavOf(m, 'a'), false);
  });

  it('已入库的不能删，记到 missing，别的 pick 照常', async () => {
    const m = make({ rows: [fm('logged', t0, { mine: true }), fm('free', t0 + 5000, { mine: true })] });
    insertQso(m.db, { id: 'q1', call: 'BD7KLO', startAt: t0, freqMhz: 438.975, band: '70cm', mode: 'FM', rstSent: '59', rstRcvd: '59', createdAt: t0 });
    resolveActivities(m.db, ['logged'], 'q1', t0);

    const res = await post(m, '/api/conversations/delete', {
      picks: [{ id: 'L', activityIds: ['logged'] }, { id: 'F', activityIds: ['free'] }],
    });
    assert.deepEqual(await res.json(), { deleted: 1, missing: ['L'] });
    assert.equal(rowCount(m, 'activity'), 1);
    assert.equal(wavOf(m, 'logged'), true);
  });

  it('空的、重复的、不存在的、跨信道的 pick 记到 missing', async () => {
    const m = make({ rows: [fm('a', t0), fm('b', t0 + 10, { channel: '另一个', freqMhz: 145.5 })] });
    const res = await post(m, '/api/conversations/delete', {
      picks: [
        { id: 'empty', activityIds: [] },
        { id: 'dup', activityIds: ['a', 'a'] },
        { id: 'ghost', activityIds: ['nope'] },
        { id: 'cross', activityIds: ['a', 'b'] },
      ],
    });
    assert.deepEqual(await res.json(), { deleted: 0, missing: ['empty', 'dup', 'ghost', 'cross'] });
    assert.equal(rowCount(m, 'activity'), 2);
  });

  it('前面一条有效 pick 用过的 id，后面再挑算已经不在了', async () => {
    const m = make({ rows: [fm('a', t0), fm('b', t0 + 10)] });
    const res = await post(m, '/api/conversations/delete', {
      picks: [{ id: 'one', activityIds: ['a'] }, { id: 'two', activityIds: ['a', 'b'] }, { id: 'three', activityIds: ['b'] }],
    });
    assert.deepEqual(await res.json(), { deleted: 2, missing: ['two'] });
    assert.equal(rowCount(m, 'activity'), 0);
  });

  it('请求体不对才 422，没有会话 401', async () => {
    const m = make();
    for (const body of [{}, { picks: 'x' }, { picks: [{ id: 1, activityIds: [] }] }, { picks: [{ id: 'a', activityIds: [1] }] }]) {
      assert.equal((await post(m, '/api/conversations/delete', body)).status, 422);
    }
    assert.equal((await req(m.app, 'POST', '/api/conversations/delete', { picks: [] }, {})).status, 401);
  });

  it('删掉的对话在各个视图里都没了', async () => {
    const m = make({ rows: [fm('a', t0, { mine: true })] });
    await post(m, '/api/conversations/delete', { picks: [{ id: 'a', activityIds: ['a'] }] });
    assert.deepEqual(await json(await get(m, '/api/pending')), []);
    const day = await json<{ items: unknown[] }>(await get(m, `/api/conversations?from=${t0 - 100}&to=${t0 + 100}`));
    assert.deepEqual(day.items, []);
  });
});

describe('POST /api/conversations/verdict', () => {
  it('204，判定压过 AI，改判回来', async () => {
    const m = make({ rows: [fm('a', t0, { mine: true })] });
    await ingest(m, 'POST', '/api/ingest/ai', [{ activityId: 'a', hasSpeech: false }]);
    const day = async () => json<{ items: { meaningless: boolean }[] }>(await get(m, `/api/conversations?from=${t0 - 100}&to=${t0 + 100}&meaningless=include`));
    assert.equal((await day()).items[0]!.meaningless, true);

    const res = await post(m, '/api/conversations/verdict', { activityIds: ['a'], meaningless: false });
    assert.equal(res.status, 204);
    const c = (await day()).items[0] as { meaningless: boolean; activities: { ai: { verdict: string } }[] };
    assert.equal(c.meaningless, false);
    assert.equal(c.activities[0]!.ai.verdict, 'keep');
    // 默认视图里它回来了
    const dflt = await json<{ items: unknown[] }>(await get(m, `/api/conversations?from=${t0 - 100}&to=${t0 + 100}`));
    assert.equal(dflt.items.length, 1);
  });

  it('有 id 不存在回 409，一个都不写', async () => {
    const m = make({ rows: [fm('a', t0)] });
    const res = await post(m, '/api/conversations/verdict', { activityIds: ['a', 'ghost'], meaningless: true });
    assert.equal(res.status, 409);
    assert.equal(rowCount(m, 'activity_verdict'), 0);
  });

  it('格式不对 422', async () => {
    const m = make({ rows: [fm('a', t0)] });
    for (const body of [{}, { activityIds: ['a'] }, { activityIds: 'a', meaningless: true }, { activityIds: ['a'], meaningless: 'yes' }, { activityIds: [], meaningless: true }]) {
      assert.equal((await post(m, '/api/conversations/verdict', body)).status, 422, JSON.stringify(body));
    }
  });
});

describe('GET /api/conversations 的 meaningless 和 view=meaningless', () => {
  it('view=meaningless 带 total，缺省 view=unlogged 不含无意义', async () => {
    const old = NOW - 10 * 86400;
    const m = make({ rows: [fm('k', old, { mine: true }), fm('r', old + 5000, { mine: true })] });
    await ingest(m, 'POST', '/api/ingest/ai', [{ activityId: 'k', hasSpeech: false }, { activityId: 'r', hasSpeech: true, category: 'qso' }]);
    const view = await json<{ items: { id: string }[]; total: number }>(await get(m, '/api/conversations?view=meaningless'));
    assert.deepEqual([view.items.map((c) => c.id), view.total], [['k'], 1]);
    const unlogged = await json<{ items: { id: string }[]; total: number }>(await get(m, '/api/conversations?view=unlogged'));
    assert.deepEqual([unlogged.items.map((c) => c.id), unlogged.total], [['r'], 1]);
  });

  it('view 不认识回 422，meaningless 不认识回 422', async () => {
    const m = make();
    assert.equal((await get(m, '/api/conversations?view=weird')).status, 422);
    assert.equal((await get(m, `/api/conversations?from=1&to=2&meaningless=maybe`)).status, 422);
  });

  it('GET /api/pending 不含无意义的，含 aiFilled', async () => {
    const m = make({ rows: [fm('k', t0, { mine: true }), fm('r', t0 + 5000, { mine: true }), fm('r2', t0 + 5030)] });
    await ingest(m, 'POST', '/api/ingest/ai', [
      { activityId: 'k', hasSpeech: false },
      { activityId: 'r', hasSpeech: true, category: 'qso' },
      { activityId: 'r2', hasSpeech: true, category: 'qso', fields: { call: 'bd7abc', qth: '海淀' } },
    ]);
    const pending = await json<{ cluster: { id: string }; draft: { call: string; qth: string }; aiFilled: string[] }[]>(await get(m, '/api/pending'));
    assert.deepEqual(pending.map((p) => p.cluster.id), ['r']);
    assert.equal(pending[0]!.draft.call, 'BD7ABC');
    assert.deepEqual(pending[0]!.aiFilled, ['call', 'qth']);
  });
});

describe('/api/ingest/ai', () => {
  it('没有 token 回 401', async () => {
    const m = make();
    assert.equal((await req(m.app, 'GET', '/api/ingest/ai/todo', undefined, {})).status, 401);
    assert.equal((await req(m.app, 'POST', '/api/ingest/ai', [], {})).status, 401);
    assert.equal((await req(m.app, 'POST', '/api/ingest/ai/status', { ok: true, message: '' }, {})).status, 401);
  });

  it('todo：新的在前，录音在才返回，limit 和 steps 验参数', async () => {
    const m = make({ rows: [fm('old', t0), fm('new', t0 + 100), fm('nowav', t0 + 200)] });
    // nowav 没有录音
    rmSync(join(m.config.recordingsDir, 'nowav.wav'));
    const res = await ingest(m, 'GET', '/api/ingest/ai/todo');
    assert.equal(res.status, 200);
    const body = await json<{ items: { id: string; mine: boolean; durationS: number }[] }>(res);
    assert.deepEqual(body.items.map((i) => i.id), ['new', 'old']);

    const one = await json<{ items: unknown[] }>(await ingest(m, 'GET', '/api/ingest/ai/todo?limit=1'));
    assert.equal(one.items.length, 1);
    for (const q of ['limit=0', 'limit=51', 'limit=x', 'steps=vad,magic']) {
      assert.equal((await ingest(m, 'GET', `/api/ingest/ai/todo?${q}`)).status, 422, q);
    }
  });

  it('todo：steps 决定有转写没提取的行算不算待办，并带上转写', async () => {
    const m = make({ rows: [fm('a', t0)] });
    await ingest(m, 'POST', '/api/ingest/ai', [{ activityId: 'a', hasSpeech: true, transcript: 'CQ CQ', asrModel: 'w' }]);
    assert.deepEqual((await json<{ items: unknown[] }>(await ingest(m, 'GET', '/api/ingest/ai/todo?steps=vad,asr'))).items, []);
    const items = (await json<{ items: { id: string; hasSpeech: boolean; transcript: string }[] }>(await ingest(m, 'GET', '/api/ingest/ai/todo?steps=vad,asr,text'))).items;
    assert.deepEqual(items.map((i) => [i.id, i.hasSpeech, i.transcript]), [['a', true, 'CQ CQ']]);
  });

  it('POST 写结果：验、合并、written，未知 id 丢掉', async () => {
    const m = make({ rows: [fm('a', t0, { mine: true })] });
    const res = await ingest(m, 'POST', '/api/ingest/ai', [
      { activityId: 'a', hasSpeech: true, category: 'qso', fields: { call: 'bd7abc', rst: '5个9', power: '5W' }, at: 1 },
      { activityId: 'ghost', hasSpeech: true },
    ]);
    assert.deepEqual(await res.json(), { written: 1 });
    const day = await json<{ items: { activities: { ai: { fields: Record<string, string> } }[] }[] }>(await get(m, `/api/conversations?from=${t0 - 100}&to=${t0 + 100}`));
    assert.deepEqual(day.items[0]!.activities[0]!.ai.fields, { call: 'BD7ABC', power: '5W' });
    assert.equal((m.db.prepare('SELECT at FROM activity_ai').get() as { at: number }).at >= NOW, true);
  });

  it('POST 不是数组回 422', async () => {
    assert.equal((await ingest(make(), 'POST', '/api/ingest/ai', { activityId: 'a' })).status, 422);
  });

  it('status：204，进 ops.ai.worker，格式不对 422', async () => {
    const m = make();
    assert.equal((await ingest(m, 'POST', '/api/ingest/ai/status', { ok: false, message: '缺模型 x' })).status, 204);
    const ops = await json<{ ai: { worker: { ok: boolean; message: string; at: number } } }>(await get(m, '/api/ops'));
    assert.deepEqual([ops.ai.worker.ok, ops.ai.worker.message], [false, '缺模型 x']);
    assert.equal(ops.ai.worker.at >= NOW, true);
    assert.equal((await ingest(m, 'POST', '/api/ingest/ai/status', { ok: 'no' })).status, 422);
  });
});

describe('GET /api/ops 的 ai', () => {
  it('关着：enabled false，todo 不数', async () => {
    const m = make({ rows: [fm('a', t0)] });
    const ai = (await json<{ ai: Record<string, unknown> }>(await get(m, '/api/ops'))).ai;
    assert.equal(ai.enabled, false);
    assert.equal(ai.todo, 0);
    assert.equal(ai.meaningless, 0);
    assert.equal(ai.doneLast24h, 0);
  });

  it('开着：提供方、待识别、24 小时完成数、无意义数和最近一次错误', async () => {
    const local = { enabled: true, vad: { provider: 'local' }, asr: { provider: 'local' }, text: { provider: 'off' } };
    const m = make({ file: { ai: local }, rows: [fm('a', t0, { mine: true }), fm('b', t0 + 1000, { mine: true }), fm('c', t0 + 2000, { mine: true }), fm('d', t0 + 3000)] });
    await ingest(m, 'POST', '/api/ingest/ai', [
      { activityId: 'a', hasSpeech: false },
      { activityId: 'b', hasSpeech: true, transcript: '你好', asrModel: 'w' },
      { activityId: 'c', error: '坏了' },
    ]);
    const ai = (await json<{ ai: Record<string, unknown> }>(await get(m, '/api/ops'))).ai;
    assert.deepEqual([ai.enabled, ai.vad, ai.asrProvider, ai.textProvider], [true, 'local', 'local', 'off']);
    // d 没有结果。c 出错但刚错过，一小时后才重试
    assert.equal(ai.todo, 1);
    assert.equal(ai.doneLast24h, 2);
    assert.equal(ai.meaningless, 1);
    assert.equal((ai.lastError as { message: string }).message, '坏了');
  });

  it('ops.ai.meaningless 和 view=meaningless 的 total 是同一个数', async () => {
    const m = make({ rows: [fm('a', t0, { mine: true }), fm('b', t0 + 1000), fm('c', t0 + 2000, { mine: true })] });
    await ingest(m, 'POST', '/api/ingest/ai', [{ activityId: 'a', hasSpeech: false }, { activityId: 'b', hasSpeech: false }, { activityId: 'c', hasSpeech: true, category: 'qso' }]);
    const ops = await json<{ ai: { meaningless: number } }>(await get(m, '/api/ops'));
    const view = await json<{ total: number }>(await get(m, '/api/conversations?view=meaningless&limit=1'));
    assert.equal(ops.ai.meaningless, view.total);
    assert.equal(view.total, 2);
  });

  it('ai 段写坏了：api 照常起来，ops 里带原因', async () => {
    const m = make({ file: { ai: { enabled: true, asr: { provider: 'chat-audio' } } } });
    const ops = await json<{ ai: { enabled: boolean; problem: string } }>(await get(m, '/api/ops'));
    assert.equal(ops.ai.enabled, false);
    assert.match(ops.ai.problem, /ai\.asr\.baseUrl 必填/);
    assert.equal((await get(m, '/api/station')).status, 200);
  });
});

describe('GET /api/station 的 aiEnabled 和 map', () => {
  it('缺省：识别关着，不用地图', async () => {
    const s = await json<Record<string, unknown>>(await get(make(), '/api/station'));
    assert.equal(s.aiEnabled, false);
    assert.deepEqual(s.map, { provider: 'none' });
  });

  it('高德：给 key，不给安全密钥', async () => {
    const m = make({ file: { ai: { enabled: true }, map: { provider: 'amap', amapKey: 'pubkey', amapSecurityCode: 'topsecret' } } });
    const res = await get(m, '/api/station');
    const text = await res.text();
    assert.equal(text.includes('topsecret'), false);
    const s = JSON.parse(text) as { aiEnabled: boolean; map: unknown };
    assert.equal(s.aiEnabled, true);
    assert.deepEqual(s.map, { provider: 'amap', amapKey: 'pubkey' });
  });

  it('OpenStreetMap 没有 key；map 写坏了当不用地图', async () => {
    const osm = await json<{ map: unknown }>(await get(make({ file: { map: { provider: 'osm', amapKey: 'x' } } }), '/api/station'));
    assert.deepEqual(osm.map, { provider: 'osm' });
    const bad = make({ file: { map: { provider: 'amap', amapKey: 'x' } } });
    assert.deepEqual((await json<{ map: unknown }>(await get(bad, '/api/station'))).map, { provider: 'none' });
    assert.match((await json<{ mapProblem: string }>(await get(bad, '/api/ops'))).mapProblem, /amapSecurityCode/);
  });
});

describe('裁剪', () => {
  it('发射被裁掉，识别结果和判定跟着删，过期的墓碑也删', async () => {
    const cutoffOld = NOW - 200 * 86400;
    const m = make({ rows: [fm('old', cutoffOld), fm('new', t0)] });
    await ingest(m, 'POST', '/api/ingest/ai', [{ activityId: 'old', hasSpeech: false }, { activityId: 'new', hasSpeech: false }]);
    await post(m, '/api/conversations/verdict', { activityIds: ['old'], meaningless: true });
    m.db.prepare('INSERT INTO deleted_activity (id, deleted_at) VALUES (?,?)').run('t-old', cutoffOld);
    m.db.prepare('INSERT INTO deleted_activity (id, deleted_at) VALUES (?,?)').run('t-new', t0);

    m.store.prune();

    const ids = (table: string, col: string) => (m.db.prepare(`SELECT ${col} AS id FROM ${table}`).all() as { id: string }[]).map((r) => r.id);
    assert.deepEqual(ids('activity_ai', 'activity_id'), ['new']);
    assert.deepEqual(ids('activity_verdict', 'activity_id'), []);
    assert.deepEqual(ids('deleted_activity', 'id'), ['t-new']);
  });
});

describe('/_AMapService 代理', () => {
  const amap = { map: { provider: 'amap', amapKey: 'pubkey', amapSecurityCode: 'topsecret' } };
  type Call = { url: string; init: RequestInit };
  function proxy(reply: () => Response | Promise<Response> = () => new Response('{"status":"1"}', { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' } })) {
    const calls: Call[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return reply();
    }) as typeof fetch;
    return { calls, m: make({ file: amap, fetch: fetcher }) };
  }
  const via = (m: Made, path: string, headers: Record<string, string> = { cookie: cookie() }, method = 'GET') =>
    m.app.fetch(new Request(`http://local${path}`, { method, headers }));

  it('补上 jscode 转到 restapi，状态、类型和内容原样带回', async () => {
    const { calls, m } = proxy();
    const res = await via(m, '/_AMapService/v3/geocode/geo?address=%E6%B5%B7%E6%B7%80&key=pubkey');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json;charset=UTF-8');
    assert.equal(await res.text(), '{"status":"1"}');
    assert.equal(calls.length, 1);
    const u = new URL(calls[0]!.url);
    assert.equal(u.origin, 'https://restapi.amap.com');
    assert.equal(u.pathname, '/v3/geocode/geo');
    assert.equal(u.searchParams.get('address'), '海淀');
    assert.equal(u.searchParams.get('key'), 'pubkey');
    assert.equal(u.searchParams.get('jscode'), 'topsecret');
  });

  it('v4/map/styles 走 webapi.amap.com', async () => {
    const { calls, m } = proxy();
    await via(m, '/_AMapService/v4/map/styles?name=x');
    assert.equal(new URL(calls[0]!.url).origin, 'https://webapi.amap.com');
  });

  it('客户端自带的 jscode 被换掉，只剩一个', async () => {
    const { calls, m } = proxy();
    await via(m, '/_AMapService/v3/geocode/geo?jscode=evil&a=1&jscode=evil2');
    const u = new URL(calls[0]!.url);
    assert.deepEqual(u.searchParams.getAll('jscode'), ['topsecret']);
    assert.equal(u.searchParams.get('a'), '1');
  });

  // //evil.example/x 要是交给 URL 解析，目标就变成 https://evil.example/x，安全密钥跟着送出去。
  it('//evil.example/x 回 400，不发请求', async () => {
    const { calls, m } = proxy();
    for (const p of ['//evil.example/x', '/v3//evil.example', '/x/y', '/', '/v3/../x', '/v3/%2e%2e/x', '/v3/a%2Fb', '/v3/a b']) {
      const res = await via(m, `/_AMapService${p}?q=1`);
      assert.equal(res.status, 400, p);
    }
    assert.equal(calls.length, 0);
  });

  it('不带任何客户端的头，只留 Accept：会话 cookie 出不去', async () => {
    const { calls, m } = proxy();
    await via(m, '/_AMapService/v3/geocode/geo', { cookie: cookie(), authorization: 'Bearer x', accept: 'application/json', 'x-forwarded-for': '1.2.3.4' });
    const sent = new Headers(calls[0]!.init.headers);
    assert.deepEqual([...sent.keys()], ['accept']);
    assert.equal(sent.get('accept'), 'application/json');
    assert.equal(calls[0]!.init.redirect, 'error');
    assert.ok(calls[0]!.init.signal);
  });

  it('要会话：没有回 401，不发请求', async () => {
    const { calls, m } = proxy();
    assert.equal((await via(m, '/_AMapService/v3/geocode/geo', {})).status, 401);
    assert.equal(calls.length, 0);
  });

  it('没选高德或者没填安全密钥回 404，不发请求', async () => {
    for (const file of [{}, { map: { provider: 'osm' } }, { map: { provider: 'amap', amapKey: 'k' } }]) {
      const calls: string[] = [];
      const m = make({ file, fetch: (async (u: string) => { calls.push(String(u)); return new Response(''); }) as unknown as typeof fetch });
      assert.equal((await via(m, '/_AMapService/v3/geocode/geo')).status, 404, JSON.stringify(file));
      assert.equal(calls.length, 0);
    }
  });

  it('只认 GET', async () => {
    const { calls, m } = proxy();
    assert.equal((await via(m, '/_AMapService/v3/geocode/geo', { cookie: cookie() }, 'POST')).status, 404);
    assert.equal(calls.length, 0);
  });

  it('上游出错回 502，响应里没有安全密钥', async () => {
    const { m } = proxy(() => {
      throw new Error('connect ECONNREFUSED https://restapi.amap.com/x?jscode=topsecret');
    });
    const res = await via(m, '/_AMapService/v3/geocode/geo');
    assert.equal(res.status, 502);
    assert.equal((await res.text()).includes('topsecret'), false);
  });

  it('上游的 4xx 原样带回', async () => {
    const { m } = proxy(() => new Response('denied', { status: 403, headers: { 'content-type': 'text/plain' } }));
    const res = await via(m, '/_AMapService/v3/geocode/geo');
    assert.deepEqual([res.status, await res.text()], [403, 'denied']);
  });

  it('在 SPA 兜底之前：有前端构建产物时也不会回首页', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'openheard-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>OpenHeard</title>');
    const calls: string[] = [];
    const m = make({ file: amap, webDist: dist, fetch: (async (u: string) => { calls.push(String(u)); return new Response('{}', { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch });
    const res = await via(m, '/_AMapService/v3/geocode/geo');
    assert.equal(await res.text(), '{}');
    assert.equal(calls.length, 1);
    // 不合规的路径同样不落到首页
    assert.equal((await via(m, '/_AMapService//evil.example/x')).status, 400);
  });
});

describe('设置里的 ai 和 map', () => {
  const cloudAi = {
    enabled: true,
    asr: { provider: 'chat-audio', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-asr', apiKey: 'KEY-ONE' },
    text: { provider: 'off' },
  };
  const diskOf = (m: Made) => JSON.parse(readFileSync(m.path, 'utf8')) as Record<string, any>;
  const settingsOf = async (m: Made) => json<Record<string, any>>(await get(m, '/api/settings'));

  it('读出来的密钥只有 *Set，字面值不出现在响应里', async () => {
    const m = make({ file: { ai: cloudAi, map: { provider: 'amap', amapKey: 'pubkey', amapSecurityCode: 'topsecret' } } });
    const res = await get(m, '/api/settings');
    const text = await res.text();
    assert.equal(text.includes('KEY-ONE') || text.includes('topsecret'), false);
    const s = JSON.parse(text);
    assert.deepEqual([s.ai.asr.apiKeySet, s.ai.text.apiKeySet, s.map.amapSecurityCodeSet, s.map.amapKey], [true, false, true, 'pubkey']);
    assert.equal('apiKey' in s.ai.asr, false);
  });

  it('没有 ai 段时读到缺省值', async () => {
    const s = await settingsOf(make());
    assert.equal(s.ai.enabled, false);
    assert.equal(s.ai.asr.language, 'zh');
    assert.equal(s.ai.text.port, 8091);
    assert.equal(s.map.provider, 'none');
  });

  // 界面读出来再整个交回去：密钥不在里面，只有 *Set。这样的保存不能被拦，也不能清掉密钥。
  it('GET 的结果原样交回去保存，密钥保留，*Set 不写进文件', async () => {
    const m = make({ file: { ai: cloudAi, map: { provider: 'amap', amapKey: 'pubkey', amapSecurityCode: 'topsecret' } } });
    const s = await settingsOf(m);
    const res = await req(m.app, 'PUT', '/api/settings', { ...s, station: { ...s.station, myQth: '都江堰' } });
    assert.equal(res.status, 200);
    const disk = diskOf(m);
    assert.equal(disk.ai.asr.apiKey, 'KEY-ONE');
    assert.equal(disk.map.amapSecurityCode, 'topsecret');
    assert.equal(JSON.stringify(disk).includes('Set'), false);
    assert.equal(disk.station.myQth, '都江堰');
    assert.equal(m.config.ai!.asr.apiKey, 'KEY-ONE');
  });

  it('密钥：缺省和 null 保留，非空设新值，空串清掉', async () => {
    const m = make({ file: { ai: cloudAi } });
    const s = await settingsOf(m);
    const put = (asr: Record<string, unknown>) => req(m.app, 'PUT', '/api/settings', { ...s, ai: { ...s.ai, asr: { ...s.ai.asr, ...asr } } });

    assert.equal((await put({ apiKey: null })).status, 200);
    assert.equal(diskOf(m).ai.asr.apiKey, 'KEY-ONE');

    assert.equal((await put({ apiKey: 'KEY-TWO' })).status, 200);
    assert.equal(diskOf(m).ai.asr.apiKey, 'KEY-TWO');
    assert.equal(m.config.ai!.asr.apiKey, 'KEY-TWO');

    // 云端要 key：清掉它就不合法，被拦下，文件不变
    const cleared = await put({ apiKey: '' });
    assert.equal(cleared.status, 422);
    assert.match(((await cleared.json()) as { error: string }).error, /ai\.asr\.apiKey 必填/);
    assert.equal(diskOf(m).ai.asr.apiKey, 'KEY-TWO');

    // 换回本机识别并清掉 key：文件里不留空串
    assert.equal((await put({ provider: 'local', apiKey: '' })).status, 200);
    assert.equal('apiKey' in diskOf(m).ai.asr, false);
    assert.equal((await settingsOf(m)).ai.asr.apiKeySet, false);
  });

  it('请求体里的 *Set 被忽略，不写，也不当成已设置', async () => {
    const m = make({ file: { ai: { ...cloudAi, asr: { ...cloudAi.asr, apiKey: undefined, provider: 'local' } } } });
    const s = await settingsOf(m);
    const res = await req(m.app, 'PUT', '/api/settings', { ...s, ai: { ...s.ai, asr: { ...s.ai.asr, apiKeySet: true } }, map: { ...s.map, amapSecurityCodeSet: true } });
    assert.equal(res.status, 200);
    assert.equal(JSON.stringify(diskOf(m)).includes('Set'), false);
    assert.equal((await settingsOf(m)).ai.asr.apiKeySet, false);
  });

  it('高德：安全密钥同样只写不读；选高德却没有安全密钥回 422', async () => {
    const m = make();
    const s = await settingsOf(m);
    const noCode = await req(m.app, 'PUT', '/api/settings', { ...s, map: { provider: 'amap', amapKey: 'pubkey' } });
    assert.equal(noCode.status, 422);
    assert.equal(diskOf(m).map, undefined);

    const ok = await req(m.app, 'PUT', '/api/settings', { ...s, map: { provider: 'amap', amapKey: 'pubkey', amapSecurityCode: 'topsecret' } });
    assert.equal(ok.status, 200);
    assert.equal(diskOf(m).map.amapSecurityCode, 'topsecret');
    assert.equal(((await ok.json()) as { map: { amapSecurityCodeSet: boolean } }).map.amapSecurityCodeSet, true);

    // 再存一次，不带安全密钥：还在
    const s2 = await settingsOf(m);
    await req(m.app, 'PUT', '/api/settings', { ...s2, map: { provider: 'amap', amapKey: 'newkey' } });
    assert.equal(diskOf(m).map.amapSecurityCode, 'topsecret');
    assert.equal(diskOf(m).map.amapKey, 'newkey');
    // 站点配置跟着变，代理立刻能用
    assert.equal(m.store.amapSecurityCode(), 'topsecret');
    assert.equal((await json<{ map: { amapKey: string } }>(await get(m, '/api/station'))).map.amapKey, 'newkey');
  });

  it('严格校验：枚举、类型、识别关着提取也要关，一处不对整个不落盘', async () => {
    const m = make();
    const s = await settingsOf(m);
    const before = readFileSync(m.path, 'utf8');
    const bad = [
      { ...s.ai, asr: { ...s.ai.asr, provider: 'whisper' } },
      { ...s.ai, text: { ...s.ai.text, port: 99999 } },
      { ...s.ai, asr: { ...s.ai.asr, provider: 'off' } },
      { ...s.ai, text: { ...s.ai.text, extraBody: 'x' } },
    ];
    for (const ai of bad) {
      assert.equal((await req(m.app, 'PUT', '/api/settings', { ...s, ai })).status, 422, JSON.stringify(ai).slice(0, 80));
    }
    assert.equal(readFileSync(m.path, 'utf8'), before);
  });

  it('文件里原来就有写坏的 ai，保存别的设置不被拦住', async () => {
    const m = make({ file: { ai: { asr: { provider: 'chat-audio' } } } });
    const s = await settingsOf(m);
    const { ai: _ai, map: _map, ...rest } = s;
    const res = await req(m.app, 'PUT', '/api/settings', { ...rest, station: { ...s.station, myQth: '成都' } });
    assert.equal(res.status, 200);
    assert.equal(diskOf(m).ai.asr.provider, 'chat-audio');
    assert.equal(diskOf(m).station.myQth, '成都');
  });

  describe('文件里写坏的 ai 和 map', () => {
    const brokenFile = {
      ai: {
        enabled: true,
        asr: { provider: 'chat-audoi', baseUrl: 'https://asr.example/v1', model: 'asr-1', apiKey: 'KEEP-ASR' },
        text: { provider: 'openai-chat', baseUrl: 'https://llm.example/v1', model: 'llm-1', apiKey: 'KEEP-TEXT' },
      },
      map: { provider: 'amapp', amapKey: 'pub', amapSecurityCode: 'KEEP-CODE' },
    };

    it('GET 带上 aiProblem 和 mapProblem，没坏就没有这两个键', async () => {
      const s = await settingsOf(make({ file: brokenFile }));
      assert.match(s.aiProblem, /ai\.asr\.provider/);
      assert.match(s.mapProblem, /map\.provider/);
      const clean = await settingsOf(make({ file: { ai: cloudAi } }));
      assert.equal('aiProblem' in clean || 'mapProblem' in clean, false);
    });

    it('保存的请求体不带这两段，文件里的原样留着', async () => {
      const m = make({ file: brokenFile });
      const s = await settingsOf(m);
      const { ai: _ai, map: _map, aiProblem: _a, mapProblem: _m, ...rest } = s;
      assert.equal((await req(m.app, 'PUT', '/api/settings', { ...rest, station: { ...s.station, myQth: '成都' } })).status, 200);
      assert.deepEqual(diskOf(m).ai, brokenFile.ai);
      assert.deepEqual(diskOf(m).map, brokenFile.map);
    });

    // 用户改的是这两段本身：界面交上来的是 GET 的缺省值再加上他改的几项，密钥不在里面。
    it('用户改了这两段：请求体里没有的密钥取文件里的，不取缺省值', async () => {
      const m = make({ file: brokenFile });
      const s = await settingsOf(m);
      const ai = {
        ...s.ai,
        enabled: true,
        asr: { ...s.ai.asr, provider: 'chat-audio', baseUrl: 'https://asr.example/v1', model: 'asr-1' },
        text: { ...s.ai.text, provider: 'openai-chat', baseUrl: 'https://llm.example/v1', model: 'llm-1' },
      };
      const res = await req(m.app, 'PUT', '/api/settings', { ...s, ai, map: { ...s.map, provider: 'amap', amapKey: 'pub' } });
      assert.equal(res.status, 200);
      const disk = diskOf(m);
      assert.equal(disk.ai.asr.apiKey, 'KEEP-ASR');
      assert.equal(disk.ai.text.apiKey, 'KEEP-TEXT');
      assert.equal(disk.ai.enabled, true);
      assert.equal(disk.map.amapSecurityCode, 'KEEP-CODE');
      // 改好了，问题也跟着没了
      const after = await settingsOf(m);
      assert.equal('aiProblem' in after || 'mapProblem' in after, false);
    });

    it('用户只改了一段，另一段坏的原样留着', async () => {
      const m = make({ file: brokenFile });
      const s = await settingsOf(m);
      const { ai: _ai, ...rest } = s;
      const res = await req(m.app, 'PUT', '/api/settings', { ...rest, map: { ...s.map, provider: 'amap', amapKey: 'pub' } });
      assert.equal(res.status, 200);
      assert.deepEqual(diskOf(m).ai, brokenFile.ai);
      assert.equal(diskOf(m).map.amapSecurityCode, 'KEEP-CODE');
    });
  });

  it('ai 的值写进文件后，extraBody 原样保留', async () => {
    const m = make();
    const s = await settingsOf(m);
    const extraBody = { thinking: { type: 'disabled' }, max_completion_tokens: 512 };
    const ai = { ...s.ai, text: { ...s.ai.text, provider: 'openai-chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'K', extraBody } };
    assert.equal((await req(m.app, 'PUT', '/api/settings', { ...s, ai })).status, 200);
    assert.deepEqual(diskOf(m).ai.text.extraBody, extraBody);
  });

  describe('错误重置', () => {
    const spent = (m: Made) => {
      // 用满 3 次重试的错误行
      m.db.prepare('INSERT INTO activity_ai (activity_id, at, attempts, meaningless, error) VALUES (?,?,?,?,?)').run('a', NOW - 10000, 3, 0, '401');
    };
    const todo = async (m: Made) => (await json<{ items: unknown[] }>(await ingest(m, 'GET', '/api/ingest/ai/todo?steps=asr'))).items.length;

    it('改了 ai 段（换了 key），用满重试次数的行重新排队', async () => {
      const m = make({ file: { ai: cloudAi }, rows: [fm('a', t0)] });
      spent(m);
      assert.equal(await todo(m), 0);

      const s = await settingsOf(m);
      await req(m.app, 'PUT', '/api/settings', { ...s, ai: { ...s.ai, asr: { ...s.ai.asr, apiKey: 'KEY-FIXED' } } });
      assert.equal(await todo(m), 1);
      assert.equal(rowCount(m, 'activity_ai'), 0);
    });

    it('没改 ai 段（只改本台）不清', async () => {
      const m = make({ file: { ai: cloudAi }, rows: [fm('a', t0)] });
      spent(m);
      const s = await settingsOf(m);
      await req(m.app, 'PUT', '/api/settings', { ...s, station: { ...s.station, myQth: '成都' } });
      assert.equal(rowCount(m, 'activity_ai'), 1);
    });

    it('api 启动时清一次', async () => {
      const m = make({ rows: [fm('a', t0), fm('b', t0 + 10)] });
      spent(m);
      m.db.prepare('INSERT INTO activity_ai (activity_id, at, meaningless, has_speech) VALUES (?,?,?,?)').run('b', NOW, 0, 1);
      assert.equal(m.store.resetAiErrors(), 1);
      assert.deepEqual((m.db.prepare('SELECT activity_id FROM activity_ai').all() as { activity_id: string }[]).map((r) => r.activity_id), ['b']);
    });
  });
});
