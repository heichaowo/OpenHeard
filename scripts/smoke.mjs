// 把真正的入口跑起来打一遍。
//
// 别的测试都是直接调 createApp 和 openDb，从来没有人跑过 api/src/index.ts：
// 读环境变量、按配置文件解析 dbPath、真的 serve 到一个端口上，这一段过去
// 只有 install.sh 装完那一下 curl 验过，也就是在 Mac mini 上、在生产里验的。
//
// 守护进程这边只验坏配置那条路。它一起来就立刻去 BrandMeister 取一次，
// CI 里不该打外网，所以不跑正常那条。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../api/src/auth.ts';

const PASSWORD = 'smoke-test-password';
const PORT = 3100 + Math.floor(process.pid % 400);
const BASE = `http://127.0.0.1:${PORT}`;
const root = new URL('..', import.meta.url).pathname;

const dir = mkdtempSync(join(tmpdir(), 'openheard-smoke-'));
const configPath = join(dir, 'openheard.config.json');
writeFileSync(
  configPath,
  JSON.stringify({
    // 相对路径，按配置文件所在目录解析。这正是过去出过错的那一处。
    dbPath: './openheard.db',
    host: '127.0.0.1',
    dmrId: 4600123,
    clusterGapS: 120,
    pendingWindowDays: 7,
    activityRetentionDays: 90,
    ingestToken: 'x'.repeat(32),
    adminPasswordHash: hashPassword(PASSWORD),
    sessionSecret: 'y'.repeat(40),
    station: { myCallsign: 'BG0CG', networkFreqMhz: 439.525 },
    channels: [],
    queries: [
      {
        key: 'dst:46001',
        rule: { id: 'DestinationID', operator: 'equal', value: 46001 },
        amount: 200,
        intervalS: 900,
      },
    ],
  }),
);

const checks = [];
const check = (name, ok, extra = '') => {
  checks.push({ name, ok, extra });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${extra ? `  ${extra}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let api;
try {
  console.log(`冒烟：真起一个 api，端口 ${PORT}，库在 ${dir}`);
  api = spawn(process.execPath, [join(root, 'api/src/index.ts')], {
    env: { ...process.env, OPENHEARD_CONFIG: configPath, OPENHEARD_PORT: String(PORT), NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  api.stdout.on('data', (b) => (out += b));
  api.stderr.on('data', (b) => (out += b));
  api.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`api 自己退了，code ${code}\n${out}`);
  });

  // 等它监听起来
  let health;
  for (let i = 0; i < 100; i++) {
    try {
      health = await fetch(`${BASE}/health`);
      break;
    } catch {
      await sleep(100);
    }
  }
  check('api 起得来并且应答 /health', health?.status === 200, health ? `HTTP ${health.status}` : '一直连不上');
  const healthBody = health ? await health.json() : {};
  check('配置是好的，health.ok 为真', healthBody.ok === true, JSON.stringify(healthBody.problems ?? []));
  check('启动日志里写了 schema 版本', /数据库第 \d+ 版/.test(out), out.split('\n')[0] ?? '');

  // 没会话的管理端路由
  const noSession = await fetch(`${BASE}/api/qsos`);
  check('没会话时管理端回 401', noSession.status === 401);

  // 登录
  const login = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  check('口令对就发 cookie', login.status === 200 && cookie.startsWith('openheard_session='));

  const withSession = await fetch(`${BASE}/api/qsos`, { headers: { cookie } });
  check('带上会话就读得到日志', withSession.status === 200 && Array.isArray(await withSession.json()));

  // 采集入口，顺带验证真的写进了磁盘上那个库
  const ingest = await fetch(`${BASE}/api/ingest/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${'x'.repeat(32)}` },
    body: JSON.stringify([
      {
        activity: { id: 'smoke-1', origin: 'sdr-fm', startAt: 1789000000, durationS: 1, mine: true, channel: '冒烟' },
        raw: '{}',
      },
    ]),
  });
  const wrote = ingest.status === 200 ? await ingest.json() : {};
  check('采集入口写得进去', wrote.written === 1, JSON.stringify(wrote));

  const again = await fetch(`${BASE}/api/ingest/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${'x'.repeat(32)}` },
    body: JSON.stringify([
      {
        activity: { id: 'smoke-1', origin: 'sdr-fm', startAt: 1789000000, durationS: 1, mine: true, channel: '冒烟' },
        raw: '{}',
      },
    ]),
  });
  check('重复推送不再写入', ((await again.json()) ?? {}).written === 0);

  // 公开面
  const summary = await fetch(`${BASE}/public/summary`);
  check('公开 summary 不要会话', summary.status === 200 && typeof (await summary.json()).total === 'number');

  // 管理端界面。构建产物在才验，CI 里 verify 先 build 再 smoke，所以是在的。
  const { existsSync } = await import('node:fs');
  if (existsSync(join(root, 'web/dist/index.html'))) {
    const page = await fetch(`${BASE}/log`);
    const html = page.status === 200 ? await page.text() : '';
    check('前端路由回首页而不是 404', page.status === 200 && html.includes('<div id="root">'));
  } else {
    check('前端路由回首页而不是 404', true, '(没有 web/dist，跳过)');
  }

  // 守护进程：只验坏配置那条路，正常那条一起来就打外网
  const bad = join(dir, 'bad.config.json');
  writeFileSync(bad, JSON.stringify({ dbPath: './x.db' }));
  const code = await new Promise((resolve) => {
    const d = spawn(process.execPath, [join(root, 'daemon/src/index.ts'), '--config', bad], {
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    d.stderr.on('data', (b) => (err += b));
    d.on('exit', (c) => resolve({ c, err }));
  });
  check('daemon 遇到坏配置就退出并说明原因', code.c === 2 && code.err.includes('配置:'), `code ${code.c}`);
} finally {
  api?.kill('SIGTERM');
  await sleep(200);
  api?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
