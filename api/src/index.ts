import { serve } from '@hono/node-server';
import { createApp, createBrokenApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { createStore } from './store.ts';

const configPath = process.env.OPENHEARD_CONFIG ?? './openheard.config.json';
const port = Number(process.env.OPENHEARD_PORT ?? 3000);

const result = loadConfig(configPath);

const app = result.ok
  ? createApp(createStore(openDb(result.config.dbPath), result.config), result.config.ingestToken, {
      passwordHash: result.config.adminPasswordHash,
      sessionSecret: result.config.sessionSecret,
    })
  : createBrokenApp(result.problems);

if (!result.ok) {
  for (const p of result.problems) console.error(`配置: ${p}`);
}

// 监听地址来自配置，默认只在本机。要从手机用就把 host 改成 0.0.0.0，
// 那时管理端靠会话口令挡着，公开路由本来就是只读的。
const host = result.ok ? result.config.host : '127.0.0.1';

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`openheard-api ${host}:${info.port}${result.ok ? '' : '（配置有问题，只回 503）'}`);
});
