import { Hono } from 'hono';
import type { PublicSource } from './store.ts';

/**
 * 公开展示页的只读路由。
 *
 * 今天挂在管理端同一个进程里。分出来是为了画边界，让公开那一面长不出写接口。
 * 数据怎么送到境外还没有方案，所以这里只接受一个注入的数据源，
 * 将来换成读导出文件或读远端 HTTP 时，改的只有注入的那一层。
 */
export function publicRoutes(source: PublicSource) {
  return new Hono()
    .get('/station', (c) => c.json(source.station()))
    .get('/qsos', (c) => c.json(source.qsos()))
    // 一个请求拿齐整页。将来导出成静态文件时，形状也是这一个。
    .get('/summary', (c) => c.json(summarise(source)));
}

const tally = <T extends string | number>(items: T[]) => {
  const m = new Map<T, number>();
  for (const v of items) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()]
    .map(([key, n]) => ({ key: String(key), n }))
    .sort((a, b) => b.n - a.n);
};

function summarise(source: PublicSource) {
  const qsos = source.qsos();
  const starts = qsos.map((q) => q.startAt);
  return {
    station: source.station(),
    total: qsos.length,
    distinctCalls: new Set(qsos.map((q) => q.call)).size,
    firstAt: starts.length ? Math.min(...starts) : undefined,
    lastAt: starts.length ? Math.max(...starts) : undefined,
    byBand: tally(qsos.map((q) => q.band)),
    byMode: tally(qsos.map((q) => q.mode)),
    // 不带本台字段和备注。RST 带上，它是别的业余电台核对这次通联时要看的，
    // 而且已经存在库里了。
    recent: qsos.slice(0, 30).map((q) => ({
      id: q.id,
      call: q.call,
      startAt: q.startAt,
      band: q.band,
      mode: q.mode,
      rstSent: q.rstSent,
      rstRcvd: q.rstRcvd,
      qth: q.qth,
      gridsquare: q.gridsquare,
    })),
    generatedAt: Math.floor(Date.now() / 1000),
  };
}
