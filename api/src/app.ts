import { Hono } from 'hono';
import type { QsoDraft } from './core.ts';
import type { IngestRow, PollLog } from './db.ts';
import { publicRoutes } from './public.ts';
import { StoreError } from './store.ts';
import type { Store } from './store.ts';

const fail = (e: unknown) => {
  if (e instanceof StoreError) {
    return { status: e.status, body: { error: e.message, missing: e.missing } };
  }
  throw e;
};

export function createApp(store: Store, ingestToken: string) {
  // 采集入口是唯一的写入口，而且将来 SDR 那侧可能从另一个进程推过来。
  const ingest = new Hono()
    .use('*', async (c, next) => {
      if (c.req.header('authorization') !== `Bearer ${ingestToken}`) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      await next();
    })
    .post('/activity', async (c) => c.json(store.ingest((await c.req.json()) as IngestRow[])))
    .post('/poll-log', async (c) => {
      store.logPoll((await c.req.json()) as PollLog);
      return c.body(null, 204);
    });

  const api = new Hono()
    .route('/ingest', ingest)
    .get('/health', (c) => {
      const h = store.health();
      return c.json(h, h.ok ? 200 : 503);
    })
    .get('/station', (c) => c.json(store.station()))
    .get('/pending', (c) => c.json(store.pending()))
    .get('/qsos', (c) => c.json(store.qsos()))

    .post('/pending/:clusterId/promote', async (c) => {
      try {
        const draft = (await c.req.json()) as QsoDraft;
        return c.json(store.promote(c.req.param('clusterId'), draft));
      } catch (e) {
        const { status, body } = fail(e);
        return c.json(body, status);
      }
    })

    .delete('/pending/:clusterId', (c) => {
      try {
        store.ignore(c.req.param('clusterId'));
        return c.body(null, 204);
      } catch (e) {
        const { status, body } = fail(e);
        return c.json(body, status);
      }
    })

    .post('/qsos', async (c) => {
      try {
        const draft = (await c.req.json()) as QsoDraft;
        return c.json(store.addQso(draft));
      } catch (e) {
        const { status, body } = fail(e);
        return c.json(body, status);
      }
    })

    .delete('/qsos/:id', (c) => {
      try {
        store.removeQso(c.req.param('id'));
        return c.body(null, 204);
      } catch (e) {
        const { status, body } = fail(e);
        return c.json(body, status);
      }
    });

  return new Hono()
    .route('/api', api)
    .route(
      '/public',
      publicRoutes({
        station: () => store.station().station,
        qsos: () => store.qsos(),
      }),
    );
}

/**
 * 配置有问题时用的降级应用。
 *
 * 照常监听，把原因放在唯一一个机器读得到的地方。退出会被 launchd 的 KeepAlive
 * 变成一个没人看得见的重启循环。
 */
export function createBrokenApp(problems: string[]) {
  return new Hono().all('*', (c) => c.json({ error: '配置有问题', problems }, 503));
}
