// 管理端的备份下载路由。和 backup.ts 那个 CLI 脚本是同一个手法
// （VACUUM INTO 一份、按「备份写完当场验」验过、发完删临时文件），
// 区别只在于这份是流式发给浏览器，不落在 backups/ 目录里。
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { Readable } from 'node:stream';
import { userVersion } from './migrations.ts';
import { backupStamp, tableCounts, verifyBackup } from './verify-backup.ts';

/**
 * 开成可读写，和 backup.ts 那个 CLI 脚本一个理由：VACUUM INTO 不动源库的
 * 内容，但只读连接恢复不了崩溃留下的 -wal，那样读到的行数会是错的。
 */
function snapshot(dbPath: string): { db: DatabaseSync; version: number; counts: Record<string, number> } {
  const db = new DatabaseSync(dbPath);
  // 这是进程内第二个连到同一个文件的连接，主连接随时可能在写。busy_timeout
  // 和主连接（db.ts openDb）用同一个值，等一下比立刻报「数据库锁住了」强。
  db.exec('PRAGMA busy_timeout = 5000');
  return { db, version: userVersion(db), counts: tableCounts(db) };
}

export function backupRoutes(dbPath: string) {
  return new Hono().get('/', async (c) => {
    const tmp = join(tmpdir(), `openheard-backup-${randomUUID()}.db`);
    const { db, version, counts } = snapshot(dbPath);
    try {
      // node:sqlite 是同步的，VACUUM INTO 这一下会卡住别的请求。库越大卡得越久，
      // 这是「管理端能下载数据库备份」那条决定里写明要接受的代价。
      db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }

    const problems = verifyBackup(tmp, { version, counts });
    if (problems.length > 0) {
      await rm(tmp, { force: true });
      return c.json({ error: `备份没验过：${problems.join('，')}` }, 500);
    }

    const filename = `openheard-${backupStamp()}.db`;
    // 发完、出错、客户端提前断开，三条路都要删掉临时文件，缺一个都会攒垃圾。
    const cleanup = () => void rm(tmp, { force: true });
    const body = createReadStream(tmp);
    body.on('close', cleanup);
    body.on('error', cleanup);
    c.req.raw.signal.addEventListener('abort', cleanup);

    return new Response(Readable.toWeb(body) as ReadableStream, {
      headers: {
        'content-type': 'application/vnd.sqlite3',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  });
}
