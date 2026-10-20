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

  // 装机前的检查用的是这里。守护进程读到写坏的信道表会直接退出，
  // 这里要是悄悄丢掉那一条，检查就放过了一份起不来的配置。
  it('信道表写坏一条就报出来，不悄悄丢掉那一条', () => {
    const { path } = write({
      analog: { channels: [{ freqMhz: 438.5, channel: 'A' }, { freqMhz: 438.975 }] },
    });
    const r = loadConfig(path);
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => p.includes('analog.channels[1].channel 必填')));
  });

  it('旧写法的单个频率读成一个信道', () => {
    const { path } = write({ analog: { freqMhz: 438.5, channel: '438.500 中继' } });
    const r = loadConfig(path);
    assert.ok(r.ok);
    assert.deepEqual(r.config.analog?.channels, [{ freqMhz: 438.5, channel: '438.500 中继' }]);
  });
});

// ai 和 map 是可选功能。写坏了不能让 api 回 503（管理端和采集入口都会跟着停），
// 也不能让守护进程退出（采集停掉）。所以读文件时宽松，只有设置页保存才严格。
describe('loadConfig 的 ai 和 map', () => {
  it('没写就是缺省值：识别关着，不用地图', () => {
    const r = loadConfig(write().path);
    assert.ok(r.ok);
    assert.equal(r.config.ai?.enabled, false);
    assert.equal(r.config.ai?.asr.language, 'zh');
    assert.equal(r.config.ai?.text.port, 8091);
    assert.equal(r.config.aiProblem, undefined);
    assert.equal(r.config.map?.provider, 'none');
  });

  it('写了的键生效，没写的补缺省', () => {
    const r = loadConfig(write({ ai: { enabled: true, asr: { language: 'en' } }, map: { provider: 'osm' } }).path);
    assert.ok(r.ok);
    assert.equal(r.config.ai?.enabled, true);
    assert.equal(r.config.ai?.asr.language, 'en');
    assert.equal(r.config.ai?.vad.threshold, 0.5);
    assert.equal(r.config.map?.provider, 'osm');
  });

  it('ai 写坏了：照常读出来，ai 是 undefined，原因在 aiProblem，不进 problems', () => {
    const r = loadConfig(write({ ai: { enabled: true, text: { provider: 'openai-chat' } } }).path);
    assert.ok(r.ok);
    assert.equal(r.config.ai, undefined);
    assert.match(r.config.aiProblem ?? '', /ai\.text\.baseUrl 必填/);
  });

  it('map 写坏了：当不用地图，原因在 mapProblem', () => {
    const r = loadConfig(write({ map: { provider: 'amap', amapKey: 'k' } }).path);
    assert.ok(r.ok);
    assert.equal(r.config.map?.provider, 'none');
    assert.match(r.config.mapProblem ?? '', /map\.amapSecurityCode 必填/);
  });

  it('ai 不是对象也不拦住启动', () => {
    const r = loadConfig(write({ ai: 'on', map: 5 }).path);
    assert.ok(r.ok);
    assert.equal(r.config.ai, undefined);
    assert.equal(r.config.aiProblem, 'ai 要是对象');
    assert.equal(r.config.mapProblem, 'map 要是对象');
  });
});

