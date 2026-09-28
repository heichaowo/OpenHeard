import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, createBrokenApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb, refreshStats } from './db.ts';
import { userVersion } from './migrations.ts';
import { createStore } from './store.ts';

const configPath = process.env.OPENHEARD_CONFIG ?? './openheard.config.json';
const port = Number(process.env.OPENHEARD_PORT ?? 3000);

const result = loadConfig(configPath);

let app;
if (result.ok) {
  // 开库时顺带跑迁移。写库的只有这一个进程，所以不用抢锁。
  const db = openDb(result.config.dbPath);
  console.log(`数据库第 ${userVersion(db)} 版：${result.config.dbPath}`);
  // 构建产物在仓库里的固定位置，不跟 cwd 走。
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const store = createStore(db, result.config);
  app = createApp(
    store,
    result.config.ingestToken,
    {
      passwordHash: result.config.adminPasswordHash,
      sessionSecret: result.config.sessionSecret,
    },
    {
      webDist,
      // 传函数，每次请求都重新问配置：设置页加上模拟守听之后，录音路由
      // 要立刻能用，不等这个进程重启。
      recordingsDir: () => result.config.recordingsDir,
      dbPath: result.config.dbPath,
    },
  );
  console.log(existsSync(webDist) ? `管理端界面：${webDist}` : `没有管理端界面，跑 npm run build --prefix web`);

  // 发射行的保留期裁剪不等轮询触发：模拟和数字两路都关着时，也不能什么都不裁。
  // 统计跟着一起补，搜呼号才走得上呼号索引，见 refreshStats。
  store.prune();
  refreshStats(db);
  setInterval(() => {
    store.prune();
    refreshStats(db);
  }, 3600_000);
} else {
  for (const p of result.problems) console.error(`配置: ${p}`);
  app = createBrokenApp(result.problems);
}

// 监听地址来自配置，默认只在本机。要从手机用就把 host 改成 0.0.0.0，
// 那时管理端靠会话口令挡着，公开路由本来就是只读的。
const host = result.ok ? result.config.host : '127.0.0.1';

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`openheard-api ${host}:${info.port}${result.ok ? '' : '（配置有问题，只回 503）'}`);
});
