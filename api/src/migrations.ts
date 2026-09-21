import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 迁移按版本号顺序跑，跑到哪一版记在 `PRAGMA user_version` 里。
 *
 * 第 1 版就是当初那份 schema.sql，整份都是 CREATE TABLE IF NOT EXISTS。
 * 已经在跑的库停在 user_version 0，跑第 1 版不改任何东西，只把版本号写上。
 * 所以老库不用特殊处理，也不用先导出再导入。
 *
 * 加一版：在 src/ 放一个 NNN-名字.sql，然后往下面那张表里加一行。跑的时候按版本号
 * 排序，所以加在哪一行都行。
 */
export interface Migration {
  version: number;
  name: string;
  /** 相对本文件的路径。 */
  file: string;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial', file: './schema.sql' },
  { version: 2, name: 'qso-history', file: './002-qso-history.sql' },
];

export const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

export function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/**
 * 把库升到 LATEST，返回这次跑了哪几版。
 *
 * 每一版单独一个事务。中间某一版挂了，库停在上一版而不是回到起点，
 * 下次重来只补没跑完的那几版。SQLite 的 DDL 也在事务里，所以挂掉的那一版不留半截。
 *
 * list 只有测试会传，跑的时候用 MIGRATIONS。
 */
export function migrate(db: DatabaseSync, list: Migration[] = MIGRATIONS): Migration[] {
  const from = userVersion(db);

  // 先按版本号排，不信任书写顺序。插在中间的一版会让 user_version 停在数组最后
  // 那一版上，比它大的那几版下次又会重跑一遍，ALTER TABLE 那种跑第二遍就报错。
  const ordered = [...list].sort((a, b) => a.version - b.version);
  const latest = ordered[ordered.length - 1].version;

  // 库比程序新，说明降级了。这时照常读写会按旧代码理解新表，所以直接不开。
  if (from > latest) {
    throw new Error(
      `数据库是第 ${from} 版，这个程序只认到第 ${latest} 版。装回新版本，或者从备份恢复。`,
    );
  }

  const todo = ordered.filter((m) => m.version > from);
  for (const m of todo) {
    const sql = readFileSync(new URL(m.file, import.meta.url), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      // user_version 不能用占位符，所以拼字符串。版本号来自上面那张常量表，不是外部输入。
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`第 ${m.version} 版（${m.name}）没跑成：${(e as Error).message}`, { cause: e });
    }
  }
  return todo;
}
