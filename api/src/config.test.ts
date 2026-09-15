import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from './config.ts';

const good = {
  dbPath: './openheard.db',
  dmrId: 4600123,
  clusterGapS: 120,
  pendingWindowDays: 7,
  activityRetentionDays: 30,
  ingestToken: 'x'.repeat(16),
  adminPasswordHash: 'scrypt$16384$aaaa$bbbb',
  sessionSecret: 'y'.repeat(32),
  station: { myCallsign: 'BG0CG' },
  channels: [],
  queries: [
    {
      key: 'dst:46001',
      rule: { id: 'DestinationID', operator: 'equal', value: 46001 },
      amount: 200,
      intervalS: 300,
    },
  ],
};

const write = (over: Record<string, unknown> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-cfg-'));
  const path = join(dir, 'openheard.config.json');
  writeFileSync(path, JSON.stringify({ ...good, ...over }));
  return { dir, path };
};

describe('loadConfig', () => {
  // 服务的 cwd 是 api/，而备份是在仓库根手敲的。同一份配置必须指向同一个文件，
  // 否则备份会对着一个不存在的路径报「还没有数据库」，然后一声不响地什么都不做。
  it('dbPath 的相对路径按配置文件所在目录算，不按 cwd', () => {
    const { dir, path } = write();
    const result = loadConfig(path);

    assert.ok(result.ok);
    assert.equal(result.config.dbPath, join(dir, 'openheard.db'));
  });

  it('dbPath 是绝对路径就原样留着', () => {
    const { path } = write({ dbPath: '/var/lib/openheard/x.db' });
    const result = loadConfig(path);

    assert.ok(result.ok);
    assert.equal(result.config.dbPath, '/var/lib/openheard/x.db');
  });

  it('缺字段就把问题一条条列出来，不抛错', () => {
    const { dir } = write();
    const path = join(dir, 'broken.json');
    writeFileSync(path, JSON.stringify({ dbPath: './x.db' }));

    const result = loadConfig(path);

    assert.ok(!result.ok);
    assert.ok(result.problems.length > 5);
  });
});
