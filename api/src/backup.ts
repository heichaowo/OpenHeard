// 备份数据库。升级前跑一次。
//
//   node src/backup.ts <配置文件> [目标目录]
//
// 用 VACUUM INTO，不用 cp。WAL 模式下 cp 拷出来的可能是半截：主库文件和 -wal
// 文件分两次读，中间写进来的改动只落在其中一边。VACUUM INTO 拿的是一个一致的
// 快照，还顺带整理了页面。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { tableCounts, verifyBackup } from './verify-backup.ts';
import { userVersion } from './migrations.ts';

const [configPath, outDir] = process.argv.slice(2);
if (!configPath) {
  console.error('用法：node src/backup.ts <配置文件> [目标目录]');
  process.exit(2);
}

const result = loadConfig(configPath);
if (!result.ok) {
  for (const p of result.problems) console.error(`配置: ${p}`);
  process.exit(1);
}

const dbPath = resolve(result.config.dbPath);
if (!existsSync(dbPath)) {
  console.log(`还没有数据库，不用备份：${dbPath}`);
  process.exit(0);
}

const dir = outDir ? resolve(outDir) : join(dirname(dbPath), 'backups');
mkdirSync(dir, { recursive: true });

// 文件名带 UTC 时刻。VACUUM INTO 不覆盖已有文件，同一秒里备份两次会直接报错，
// 所以撞名就往后加序号。
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
let out = join(dir, `openheard-${stamp}.db`);
for (let n = 2; existsSync(out); n++) out = join(dir, `openheard-${stamp}-${n}.db`);

// 开成可读写。VACUUM INTO 不动源库的内容，而只读连接恢复不了崩溃留下的 -wal。
const db = new DatabaseSync(dbPath);
const version = userVersion(db);
const before = tableCounts(db);
db.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
db.close();

const problems = verifyBackup(out, { version, counts: before });
if (problems.length > 0) {
  console.error(`备份验不过：${out}`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`备份好了：${out}`);
console.log(`  ${(statSync(out).size / 1024).toFixed(0)} KB，第 ${version} 版 schema`);
console.log(
  `  验过：integrity_check ok，` +
    Object.entries(before)
      .map(([t, n]) => `${t} ${n}`)
      .join('，'),
);
