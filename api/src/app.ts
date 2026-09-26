import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { COOKIE, SESSION_DAYS, signSession, verifyPassword, verifySession } from './auth.ts';
import type { ClusterPick, QsoDraft } from './core.ts';
import type { IngestRow, PollLog } from './db.ts';
import { publicRoutes } from './public.ts';
import { recordingRoutes } from './recordings.ts';
import { StoreError } from './store.ts';
import { createRadioState, parseRadio } from './radio.ts';
import { createThrottle } from './throttle.ts';
import type { Store } from './store.ts';

const fail = (e: unknown) => {
  if (e instanceof StoreError) {
    return { status: e.status, body: { error: e.message, missing: e.missing } };
  }
  throw e;
};

const isPick = (x: unknown): x is ClusterPick => {
  const p = x as Partial<ClusterPick> | null;
  return (
    typeof p?.clusterId === 'string' &&
    Array.isArray(p.activityIds) &&
    p.activityIds.every((id) => typeof id === 'string')
  );
};

/**
 * 请求体上限。最大的正常请求是导入 ADIF，五万条也不到 6 MB。
 * 不设的话，一个几百 MB 的请求体会整个读进内存再去解析。
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** 登录口的限速：一个来源五分钟内最多十次。 */
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX = 10;

export function createApp(
  store: Store,
  ingestToken: string,
  auth: { passwordHash: string; sessionSecret: string },
  options: {
    loginThrottle?: ReturnType<typeof createThrottle>;
    /** 管理端 SPA 的构建产物目录。给了就在根路径上把它发出去。 */
    webDist?: string;
    /** 模拟侧录音的目录。 */
    recordingsDir?: string;
  } = {},
) {
  const nowS = () => Math.floor(Date.now() / 1000);
  const throttle =
    options.loginThrottle ?? createThrottle({ windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX });
  const radio = createRadioState();

  // 采集入口是唯一的写入口，而且将来 SDR 那侧可能从另一个进程推过来。
  const ingest = new Hono()
    .use('*', async (c, next) => {
      if (c.req.header('authorization') !== `Bearer ${ingestToken}`) {
        return c.json({ error: '采集 token 不对' }, 401);
      }
      await next();
    })
    .post('/activity', async (c) => c.json(store.ingest((await c.req.json()) as IngestRow[])))
    // 电台状态。每秒一条，只留最新的一条在内存里，不入库。
    .post('/radio', async (c) => {
      const status = parseRadio(await c.req.json(), nowS());
      if (status !== undefined) radio.set(status);
      return c.body(null, 204);
    })
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
        // 走 Tailscale 时前面是它在终结 TLS，请求到这里是明文回环，
        // 所以看转发头。伪造这个头只会让伪造者自己的 cookie 存不下来。
        secure: isHttps(c.req.header('x-forwarded-proto'), c.req.url),
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
    .get('/ops', (c) => c.json({ ...store.ops(), radio: radio.view(nowS()) }))
    .get('/station', (c) => c.json(store.station()))
    .get('/pending', (c) => c.json(store.pending()))
    .get('/qsos', (c) => c.json(store.qsos()))
    .get('/qsos/:id/history', (c) => c.json(store.qsoHistory(c.req.param('id'))))

    .get('/activities', (c) => {
      try {
        return c.json(
          store.heard({
            origin: c.req.query('origin'),
            cursor: c.req.query('cursor'),
            limit: c.req.query('limit'),
          }),
        );
      } catch (e) {
        const { status, body } = fail(e);
        return c.json(body, status);
      }
    })

    .post('/pending/:clusterId/promote', async (c) => {
      try {
        const body = (await c.req.json()) as QsoDraft & { activityIds?: string[] };
        const { activityIds, ...draft } = body;
        return c.json(store.promote(c.req.param('clusterId'), draft, activityIds));
      } catch (e) {
        const { status, body } = fail(e);
        return c.json(body, status);
      }
    })

    .post('/pending/ignore', async (c) => {
      const { picks } = (await c.req.json()) as { picks?: unknown };
      if (!Array.isArray(picks) || !picks.every(isPick)) {
        return c.json({ error: 'picks 要是 {clusterId, activityIds} 数组' }, 422);
      }
      return c.json(store.ignoreMany(picks));
    })

    .delete('/pending/:clusterId', (c) => {
      try {
        // 只忽略其中几次发射：?activityIds=a,b
        const only = c.req.query('activityIds');
        store.ignore(c.req.param('clusterId'), only === undefined ? undefined : only.split(','));
        return c.body(null, 204);
      } catch (e) {
        const { status, body } = fail(e);
        return c.json(body, status);
      }
    })

    // ADIF 文本直接当请求体，不走 multipart。一个人从浏览器传一个文件，
    // 为它引一套表单解析不划算。
    .post('/qsos/import', async (c) => {
      try {
        return c.json(store.importAdif(await c.req.text()));
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

    .route('/recordings', recordingRoutes(options.recordingsDir))

    .get('/settings', (c) => c.json(store.settings()))

    .put('/settings', async (c) => {
      try {
        return c.json(store.saveSettings(await c.req.json()));
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

  const api = new Hono()
    .use(
      '*',
      bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => c.json({ error: `请求体超过 ${MAX_BODY_BYTES / 1024 / 1024} MB` }, 413),
      }),
    )
    .route('/ingest', ingest)
    .route('/session', session)
    .route('/', guarded);

  const app = new Hono()
    // 没接住的异常也回 JSON。带 try/catch 的路由回 {error}，而几个只读的 GET
    // 没有，掉进 Hono 默认的纯文本 500，前端按 JSON 解就会得到一句没头没脑的话。
    .onError((e, c) => {
      console.error('没接住的异常:', e);
      return c.json({ error: '服务端出错了，看 api.err.log' }, 500);
    })
    // 没匹配上的路由也回 JSON。前端按 JSON 解，拿到纯文本只会得到一句看不懂的话。
    .notFound((c) => c.json({ error: '没有这个接口' }, 404))
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

  // 管理端界面。不发它的话，机器上只有接口，手机连过来是一片 404。
  // 静态文件不要会话，会话挡的是它背后的接口。
  const dist = options.webDist;
  if (dist !== undefined && existsSync(join(dist, 'index.html'))) {
    const index = join(dist, 'index.html');
    // assets 下的文件名带内容散列，改了就是另一个名字，可以放心长期缓存。
    app.use('/assets/*', async (c, next) => {
      await next();
      c.header('cache-control', 'public, max-age=31536000, immutable');
    });
    app.use('/assets/*', serveStatic({ root: dist }));
    app.get('/favicon.svg', serveStatic({ root: dist }));
    // 前端是单页应用，/log、/ops 这些路由只有浏览器知道，服务端一律回首页。
    //
    // 首页必须不缓存。它里面写死了那几个带散列的文件名，浏览器把它缓存住的话，
    // 升级之后还会去取旧的那一份，于是人看到的是上一版界面，而且会以为新功能
    // 根本没做出来。
    app.get('*', (c) => {
      c.header('cache-control', 'no-store');
      return c.html(readFileSync(index, 'utf8'));
    });
  }

  return app;
}

/** 这次请求是不是从 https 过来的。前面可能有 Tailscale 在终结 TLS。 */
function isHttps(forwardedProto: string | undefined, url: string): boolean {
  if (forwardedProto !== undefined) return forwardedProto.split(',')[0].trim() === 'https';
  return url.startsWith('https:');
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
