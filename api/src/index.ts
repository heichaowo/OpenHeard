import { serve } from '@hono/node-server';
import { createApp, createBrokenApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { createStore } from './store.ts';

const configPath = process.env.OPENHEARD_CONFIG ?? './openheard.config.json';
const port = Number(process.env.OPENHEARD_PORT ?? 3000);

const result = loadConfig(configPath);

const app = result.ok
  ? createApp(createStore(openDb(result.config.dbPath), result.config))
  : createBrokenApp(result.problems);

if (!result.ok) {
  for (const p of result.problems) console.error(`配置: ${p}`);
}

// 只监听回环地址。管理端不对外，公开页将来另外部署。
serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
  console.log(`openheard-api 127.0.0.1:${info.port}${result.ok ? '' : '（配置有问题，只回 503）'}`);
});
