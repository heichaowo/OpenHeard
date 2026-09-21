import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { COOKIE, SESSION_DAYS, signSession, verifyPassword, verifySession } from './auth.ts';
import type { QsoDraft } from './core.ts';
import type { IngestRow, PollLog } from './db.ts';
import { publicRoutes } from './public.ts';
import { StoreError } from './store.ts';
import { createThrottle } from './throttle.ts';
import type { Store } from './store.ts';

const fail = (e: unknown) => {
  if (e instanceof StoreError) {
    return { status: e.status, body: { error: e.message, missing: e.missing } };
  }
  throw e;
};

/** 登录口的限速：一个来源五分钟内最多十次。 */
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX = 10;

export function createApp(
  store: Store,
  ingestToken: string,
  auth: { passwordHash: string; sessionSecret: string },
  options: { loginThrottle?: ReturnType<typeof createThrottle> } = {},
) {
  const nowS = () => Math.floor(Date.now() / 1000);
  const throttle =
    options.loginThrottle ?? createThrottle({ windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX });

  // 采集入口是唯一的写入口，而且将来 SDR 那侧可能从另一个进程推过来。
  const ingest = new Hono()
    .use('*', async (c, next) => {
      if (c.req.header('authorization') !== `Bearer ${ingestToken}`) {
        return c.json({ error: '采集 token 不对' }, 401);
      }
      await next();
    })
    .post('/activity', async (c) => c.json(store.ingest((await c.req.json()) as IngestRow[])))
    .post('/poll-log', async (c) => {
      store.logPoll((await c.req.json()) as PollLog);
      return c.body(null, 204);
    });

  // 登录本身不能要求已登录，采集入口走自己的 bearer token。
  const session = new Hono()
    .get('/', (c) =>
      c.json({ signedIn: verifySession(auth.sessionSecret, getCookie(c, COOKIE), nowS()) }),
    )
    .post('/', async (c) => {
      // 按来源地址限速。取不到地址时归到同一个桶里，宁可误伤也不要留个空门。
      // getConnInfo 要有底下那个 socket，测试里直接 fetch 到 app 上时没有。
      let from = 'unknown';
      try {
        from = getConnInfo(c).remote.address ?? 'unknown';
      } catch {
        from = 'unknown';
      }
      const allowed = throttle.check(from, Date.now());
      if (!allowed.ok) {
        c.header('Retry-After', String(allowed.retryAfterS));
        return c.json({ error: `试得太频繁，${allowed.retryAfterS} 秒后再来` }, 429);
      }

      const { password } = (await c.req.json()) as { password?: string };
      if (typeof password !== 'string' || !verifyPassword(password, auth.passwordHash)) {
        return c.json({ error: '口令不对' }, 401);
      }
      throttle.clear(from);
      const exp = nowS() + SESSION_DAYS * 86400;
      setCookie(c, COOKIE, signSession(auth.sessionSecret, exp), {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: SESSION_DAYS * 86400,
      });
      return c.json({ signedIn: true });
    })
    .delete('/', (c) => {
      deleteCookie(c, COOKIE, { path: '/' });
      return c.json({ signedIn: false });
    });

  const guarded = new Hono()
    .use('*', async (c, next) => {
      if (!verifySession(auth.sessionSecret, getCookie(c, COOKIE), nowS())) {
        return c.json({ error: '没登录' }, 401);
      }
      await next();
    })
    .get('/ops', (c) => c.json(store.ops()))
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

    .put('/qsos/:id', async (c) => {
      try {
        const draft = (await c.req.json()) as QsoDraft;
        return c.json(store.editQso(c.req.param('id'), draft));
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

  const api = new Hono().route('/ingest', ingest).route('/session', session).route('/', guarded);

  return new Hono()
    // 没接住的异常也回 JSON。带 try/catch 的路由回 {error}，而几个只读的 GET
    // 没有，掉进 Hono 默认的纯文本 500，前端按 JSON 解就会得到一句没头没脑的话。
    .onError((e, c) => {
      console.error('没接住的异常:', e);
      return c.json({ error: '服务端出错了，看 api.err.log' }, 500);
    })
    // 健康检查不要会话，否则一行 curl 的外部监控就用不上它。
    // 只回 ok 和原因，计数、路径和磁盘留在 /api/ops 后面。
    .get('/health', (c) => {
      const h = store.health();
      return c.json({ ok: h.ok, problems: h.problems }, h.ok ? 200 : 503);
    })
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
