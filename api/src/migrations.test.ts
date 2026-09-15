import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { openDb } from './db.ts';
import { LATEST, MIGRATIONS, migrate, userVersion } from './migrations.ts';

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as
    { name: string }[]).map((r) => r.name);

describe('migrate', () => {
  it('空库升到最新版并建出四张表', () => {
    const db = new DatabaseSync(':memory:');
    const ran = migrate(db);

    assert.deepEqual(ran.map((m) => m.version), MIGRATIONS.map((m) => m.version));
    assert.equal(userVersion(db), LATEST);
    assert.deepEqual(tables(db).filter((n) => !n.startsWith('sqlite_')), [
      'activity',
      'poll_log',
      'qso',
      'resolved_activity',
    ]);
  });

  it('再跑一次什么都不做', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    assert.deepEqual(migrate(db), []);
    assert.equal(userVersion(db), LATEST);
  });

  // 这条是给已经在跑的那个库的。它建表时还没有迁移，所以停在第 0 版，
  // 表却是全的。第 1 版必须认下它，而不是把数据冲掉。
  it('认下第 0 版的老库，数据不动', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare(
      "INSERT INTO qso (id, call, start_at, freq_mhz, band, mode, rst_sent, rst_rcvd, created_at)" +
        " VALUES ('q1', 'BG0CG', 1, 438.7, '70cm', 'FM', '59', '59', 1)",
    ).run();
    db.exec('PRAGMA user_version = 0'); // 装回成老库的样子

    const ran = migrate(db);

    assert.equal(ran.length, 1);
    assert.equal(userVersion(db), LATEST);
    assert.equal((db.prepare('SELECT count(*) n FROM qso').get() as { n: number }).n, 1);
  });

  it('库比程序新就不开', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.exec(`PRAGMA user_version = ${LATEST + 1}`);

    assert.throws(() => migrate(db), /只认到第/);
  });

  // 挂掉的那一版不留半截，版本号也不往前走，所以重来一次是安全的。
  it('某一版挂了就回滚，版本号停在上一版', () => {
    const db = new DatabaseSync(':memory:');
    const list = [
      ...MIGRATIONS,
      { version: LATEST + 1, name: 'bad', file: './migrations.test-broken.sql' },
    ];

    assert.throws(() => migrate(db, list), /没跑成/);
    assert.equal(userVersion(db), LATEST);
    assert.ok(!tables(db).includes('halfway'));
  });

  // 版本号写在数组哪一行都行。按书写顺序跑的话，user_version 会停在最后那一行的
  // 版本上，比它大的那几版下次重跑，ALTER TABLE 第二遍就报 duplicate column。
  it('按版本号跑，不按数组顺序', () => {
    const db = new DatabaseSync(':memory:');
    const list = [
      ...MIGRATIONS,
      { version: LATEST + 2, name: 'later', file: './migrations.test-later.sql' },
      { version: LATEST + 1, name: 'extra', file: './migrations.test-extra.sql' },
    ];

    const ran = migrate(db, list);

    assert.deepEqual(ran.map((m) => m.version), [LATEST, LATEST + 1, LATEST + 2]);
    assert.equal(userVersion(db), LATEST + 2);
    assert.deepEqual(migrate(db, list), []);
  });

  it('openDb 开完就是最新版', () => {
    const db = openDb(':memory:');
    assert.equal(userVersion(db), LATEST);
  });
});
