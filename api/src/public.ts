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
    .get('/qsos', (c) => c.json(source.qsos()));
}
