import { statfsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';

export interface Health {
  ok: boolean;
  problems: string[];
  lastPollAt?: number;
  activityCount: number;
  qsoCount: number;
  freeBytes?: number;
}

const one = (db: DatabaseSync, sql: string) =>
  Number((db.prepare(sql).get() as { n: number }).n);

/** 磁盘低于这个值就算不健康。写不进去时 daemon 那边的行会永久丢掉。 */
const MIN_FREE_BYTES = 1_000_000_000;

/** 连续这么多次都不对才报，免得偶发抖动一直响。 */
const STREAK = 3;

/**
 * 无人值守时唯一能读到的东西。
 *
 * 不健康时返回 503，这样一行 curl 就能当外部检查用。
 */
export function checkHealth(db: DatabaseSync, config: Config, now: number): Health {
  const problems: string[] = [];

  const lastPollAt = (
    db.prepare('SELECT MAX(at) AS n FROM poll_log').get() as { n: number | null }
  ).n;

  const slowest = config.queries.reduce((m, q) => Math.max(m, q.intervalS), 0);
  if (slowest > 0) {
    if (lastPollAt === null) {
      problems.push('还没有过一次轮询');
    } else if (now - lastPollAt > slowest * 3) {
      problems.push(`最近一次轮询在 ${now - lastPollAt} 秒前，超过最慢那条查询间隔的三倍`);
    }
  }

  for (const q of config.queries) {
    const last = db
      .prepare('SELECT fetched, parsed FROM poll_log WHERE query_key = ? ORDER BY at DESC LIMIT ?')
      .all(q.key, STREAK) as { fetched: number; parsed: number }[];
    if (last.length < STREAK) continue;

    // 来源改了字段名时 normalise 会把整批丢光。这和「这批全是重复行」的
    // 计数长得一样，所以要靠 parsed 才分得出来。
    if (last.every((r) => r.fetched > 0 && r.parsed === 0)) {
      problems.push(`${q.key} 连续 ${STREAK} 次取回了行但一条都没解析出来，来源可能改了字段`);
    }
    // 话务组不存在长时间 0 行；本台几天不发射是正常的，所以只查话务组。
    if (q.key.startsWith('dst:') && last.every((r) => r.fetched === 0)) {
      problems.push(`${q.key} 连续 ${STREAK} 次一行都没取到`);
    }
  }

  let freeBytes: number | undefined;
  try {
    const fs = statfsSync(config.dbPath);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
    if (freeBytes < MIN_FREE_BYTES) problems.push(`磁盘只剩 ${freeBytes} 字节`);
  } catch {
    // 库文件还没建出来时读不到，不算问题。
  }

  return {
    ok: problems.length === 0,
    problems,
    lastPollAt: lastPollAt ?? undefined,
    activityCount: one(db, 'SELECT COUNT(*) AS n FROM activity'),
    qsoCount: one(db, 'SELECT COUNT(*) AS n FROM qso'),
    freeBytes,
  };
}
