import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from './app.ts';
import { COOKIE, SESSION_DAYS, hashPassword, signSession } from './auth.ts';
import type { Activity } from './core.ts';
import { insertActivities, openDb } from './db.ts';
import { createStore } from './store.ts';
import type { Config } from './config.ts';

const dbPathOf = () => join(mkdtempSync(join(tmpdir(), 'openheard-backup-route-')), 'openheard.db');

const config: Config = {
  dbPath: ':memory:', // 被下面每个测试的真实路径覆盖
  path: '/tmp/openheard-backup-route-test.config.json',
  host: '127.0.0.1',
  adminPasswordHash: hashPassword('secret'),
  sessionSecret: 's'.repeat(40),
  dmrId: 4600123,
  clusterGapS: 120,
  pendingWindowDays: 7,
  activityRetentionDays: 90,
  ingestToken: 'x'.repeat(32),
  station: {},
  channels: [],
  queries: [],
  brandmeisterEnabled: true,
  recordingsDir: '/tmp/openheard-backup-route-recordings',
};

const cookie = () =>
  `${COOKIE}=${signSession(config.sessionSecret, Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400)}`;

function setup(dbPath: string) {
  const db = openDb(dbPath);
  insertActivities(
    db,
    [{ activity: { id: 'a', origin: 'brandmeister', startAt: 1, durationS: 5, mine: false } as Activity, raw: '{}' }],
    1,
  );
  const cfg = { ...config, dbPath };
  return createApp(createStore(db, cfg), cfg.ingestToken, {
    passwordHash: cfg.adminPasswordHash,
    sessionSecret: cfg.sessionSecret,
  }, { dbPath });
}

describe('GET /api/backup', () => {
  it('验过之后流式发出去，是一份真的 SQLite 文件', async () => {
    const dbPath = dbPathOf();
    const app = setup(dbPath);

    const res = await app.fetch(new Request('http://local/api/backup', { headers: { cookie: cookie() } }));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.sqlite3');
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="openheard-\d{8}T\d{6}Z\.db"/);

    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 16).toString('utf8'), 'SQLite format 3\0');
  });

  it('发完就删掉临时文件，不留垃圾', async () => {
    const dbPath = dbPathOf();
    const app = setup(dbPath);
    // close 事件是异步的，等前一个用例（如果也刚发完）的清理先落定，
    // 这条只看它自己这一次请求造成的净变化。
    await sleep(100);
    const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('openheard-backup-') && !f.startsWith('openheard-backup-route-')));

    await (await app.fetch(new Request('http://local/api/backup', { headers: { cookie: cookie() } }))).arrayBuffer();
    await sleep(100);

    const after = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('openheard-backup-') && !f.startsWith('openheard-backup-route-')));
    assert.deepEqual(after, before);
  });

  it('要会话', async () => {
    const dbPath = dbPathOf();
    const app = setup(dbPath);
    const res = await app.fetch(new Request('http://local/api/backup'));
    assert.equal(res.status, 401);
  });

  it('没给 dbPath 时不挂这条路由', async () => {
    const dbPath = dbPathOf();
    const db = openDb(dbPath);
    const cfg = { ...config, dbPath };
    const app = createApp(createStore(db, cfg), cfg.ingestToken, {
      passwordHash: cfg.adminPasswordHash,
      sessionSecret: cfg.sessionSecret,
    });
    const res = await app.fetch(new Request('http://local/api/backup', { headers: { cookie: cookie() } }));
    assert.notEqual(res.status, 200);
  });
});
