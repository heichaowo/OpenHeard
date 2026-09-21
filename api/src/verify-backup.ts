import { DatabaseSync } from 'node:sqlite';
import { userVersion } from './migrations.ts';

/** 备份前后各数一遍的那几张表。 */
const TABLES = ['activity', 'resolved_activity', 'qso', 'poll_log'];

export function tableCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    out[t] = Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
  }
  return out;
}

/**
 * 验一份刚写出来的备份。返回问题清单，空数组表示没问题。
 *
 * `VACUUM INTO` 没报错，不等于那个文件打得开。`qso` 是人判断过的结果，只有这一份，
 * 重建不出来，而备份坏没坏，等到要恢复的那天才发现就太晚了。
 */
export function verifyBackup(
  path: string,
  expect: { version: number; counts: Record<string, number> },
): string[] {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    return [`打不开：${(e as Error).message}`];
  }

  try {
    const check = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
      .integrity_check;
    if (check !== 'ok') return [`integrity_check 说：${check}`];

    const problems: string[] = [];
    const version = userVersion(db);
    if (version !== expect.version) {
      problems.push(`schema 版本对不上：${expect.version} -> ${version}`);
    }
    const after = tableCounts(db);
    for (const t of TABLES) {
      if (after[t] !== expect.counts[t]) {
        problems.push(`${t} 行数对不上：${expect.counts[t]} -> ${after[t]}`);
      }
    }
    return problems;
  } catch (e) {
    // 表都读不出来，说明这个文件根本不是一个能用的库。
    return [`读不了：${(e as Error).message}`];
  } finally {
    db.close();
  }
}
