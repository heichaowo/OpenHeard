import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { Qso } from './core.ts';
import { insertQso, openDb } from './db.ts';
import { userVersion } from './migrations.ts';
import { tableCounts, verifyBackup } from './verify-backup.ts';

const qso = (id: string): Qso => ({
  id,
  call: 'BD7KLO',
  startAt: 1_789_000_000,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'FM',
  rstSent: '59',
  rstRcvd: '59',
  createdAt: 1_789_000_000,
});

/** 造一个真库，再用 VACUUM INTO 备份出来，返回两边的路径和该有的样子。 */
function madeBackup(rows = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-bk-'));
  const db = openDb(join(dir, 'source.db'));
  for (let i = 0; i < rows; i++) insertQso(db, qso(`q${i}`));
  const expect = { version: userVersion(db), counts: tableCounts(db) };
  const out = join(dir, 'backup.db');
  db.exec(`VACUUM INTO '${out}'`);
  db.close();
  return { dir, out, expect };
}

describe('verifyBackup', () => {
  it('刚写出来的备份验得过', () => {
    const { out, expect } = madeBackup();
    assert.deepEqual(verifyBackup(out, expect), []);
  });

  // 「VACUUM INTO 没报错」和「这个文件能用」是两件事。
  it('文件被截断就报出来，不当成备份好了', () => {
    const { out, expect } = madeBackup();
    writeFileSync(out, Buffer.alloc(4096));

    const problems = verifyBackup(out, expect);

    assert.equal(problems.length > 0, true);
  });

  it('根本不是库就报打不开或读不了', () => {
    const { dir, expect } = madeBackup();
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, '这不是 SQLite');

    const problems = verifyBackup(junk, expect);

    assert.equal(problems.length > 0, true);
  });

  it('行数对不上就报出来', () => {
    const { out, expect } = madeBackup(3);
    const wrong = { ...expect, counts: { ...expect.counts, qso: 99 } };

    assert.deepEqual(verifyBackup(out, wrong), ['qso 行数对不上：99 -> 3']);
  });

  it('schema 版本对不上就报出来', () => {
    const { out, expect } = madeBackup();

    const problems = verifyBackup(out, { ...expect, version: expect.version + 1 });

    assert.equal(problems[0], `schema 版本对不上：${expect.version + 1} -> ${expect.version}`);
  });

  it('少一张表也算读不了', () => {
    const { dir, expect } = madeBackup();
    const bare = join(dir, 'bare.db');
    const db = new DatabaseSync(bare);
    db.exec('CREATE TABLE activity (id TEXT)');
    db.close();

    const problems = verifyBackup(bare, expect);

    assert.equal(problems.length > 0, true);
  });
});
