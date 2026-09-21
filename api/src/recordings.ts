import { Hono } from 'hono';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { Readable } from 'node:stream';

/**
 * 模拟侧每次发射的录音。
 *
 * 守护进程把每次静噪开启存成 `<activity id>.wav`，在这以前没有任何地方读它。
 * 模拟 FM 空中不带身份信息，对方呼号只能靠人回忆，所以确认的时候要能听回去。
 *
 * 挂在会话后面：这是本台信道上的音频，不属于公开面。
 */
export function recordingRoutes(dir: string | undefined) {
  return new Hono()
    // 哪些发射有录音。界面据此决定给哪几行放播放器，免得挨个探一次 404。
    .get('/', (c) => {
      if (dir === undefined || !existsSync(dir)) return c.json<string[]>([]);
      const ids = readdirSync(dir)
        .filter((f) => f.endsWith('.wav'))
        .map((f) => f.slice(0, -4));
      return c.json(ids);
    })

    .get('/:id', (c) => {
      if (dir === undefined) return c.json({ error: '没配模拟守听，没有录音' }, 404);
      const id = c.req.param('id');
      // id 来自 URL，不能让它跑出录音目录。
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return c.json({ error: '不是合法的 id' }, 400);

      const file = join(dir, `${id}.wav`);
      if (!existsSync(file)) return c.json({ error: '这次发射没有录音' }, 404);

      const size = statSync(file).size;
      return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
        headers: {
          'content-type': 'audio/wav',
          'content-length': String(size),
          // 录音写完就不再变，缓存起来省得每次拖进度条都重下。
          'cache-control': 'private, max-age=86400',
        },
      });
    });
}
