import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from './config.ts';
import { checkSettings, writeSettings } from './settings.ts';
import type { Settings } from './settings.ts';

const base = {
  dbPath: './openheard.db',
  dmrId: 4616460,
  clusterGapS: 120,
  pendingWindowDays: 7,
  activityRetentionDays: 90,
  ingestToken: 'x'.repeat(32),
  adminPasswordHash: 'scrypt$16384$aa$bb',
  sessionSecret: 'y'.repeat(40),
  station: { myCallsign: 'BG0CG' },
  channels: [{ name: '439.525 中继', freqMhz: 439.525, mode: 'FM' }],
  analog: { freqMhz: 438.7, channel: '438.700 直频', myUnitId: '6460', recordingsDir: './rec' },
  queries: [
    {
      key: 'dst:46001',
      rule: { id: 'DestinationID', operator: 'equal', value: 46001 },
      amount: 200,
      intervalS: 900,
    },
  ],
};

const ok: Settings = {
  station: base.station,
  channels: base.channels as Settings['channels'],
  queries: base.queries as Settings['queries'],
  analog: { freqMhz: 145.5, channel: '145.500 直频', gainDb: 40.2, myUnitId: 'ABCD' },
};

function written(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-set-'));
  const path = join(dir, 'openheard.config.json');
  // 带一条注释键，写回之后必须还在
  writeFileSync(path, JSON.stringify({ '//note': '别弄丢我', ...base, ...extra }, null, 2), {
    mode: 0o600,
  });
  const r = loadConfig(path);
  assert.ok(r.ok);
  return { path, config: r.config };
}

describe('checkSettings', () => {
  it('好的设置没有问题', () => {
    assert.deepEqual(checkSettings(ok), []);
  });

  // 调谐器调不到的频率写进去，守护进程会起来就崩，然后每 5 秒重来一次。
  it('频率不在 2m 或 70cm 段内就拦住', () => {
    for (const f of [100, 200, 500, 0]) {
      assert.ok(checkSettings({ ...ok, analog: { ...ok.analog, freqMhz: f } }).length > 0, String(f));
    }
    assert.deepEqual(checkSettings({ ...ok, analog: { ...ok.analog, freqMhz: 439.525 } }), []);
  });

  it('unit id 要是十六进制', () => {
    assert.ok(checkSettings({ ...ok, analog: { ...ok.analog, myUnitId: 'XYZQ' } }).length > 0);
    assert.ok(checkSettings({ ...ok, analog: { ...ok.analog, myUnitId: '12345' } }).length > 0);
    assert.deepEqual(checkSettings({ ...ok, analog: { ...ok.analog, myUnitId: '6460' } }), []);
  });

  it('查询走的是和配置同一套校验', () => {
    const bad = checkSettings({ ...ok, queries: [{ rule: { id: 'DestinationID', operator: 'equal', value: '46001' } }] });
    assert.ok(bad.some((p) => p.includes('必须是 JSON 数字')));
    assert.ok(bad.some((p) => p.includes('key 必填')));
  });

  it('信道要有名字、合法频率和已知模式', () => {
    assert.ok(checkSettings({ ...ok, channels: [{ name: '', freqMhz: 439.5, mode: 'FM' }] }).length > 0);
    assert.ok(checkSettings({ ...ok, channels: [{ name: 'x', freqMhz: 439.5, mode: 'SSB' }] }).length > 0);
  });
});

describe('writeSettings', () => {
  it('写回文件，重新读出来是新值', () => {
    const { path, config } = written();

    writeSettings(config, ok);

    const again = loadConfig(path);
    assert.ok(again.ok);
    assert.equal(again.config.analog?.freqMhz, 145.5);
    assert.equal(again.config.analog?.myUnitId, 'ABCD');
    assert.equal(again.config.channels.length, 1);
  });

  // 只改内存的话 launchd 下次重启就悄悄变回去，而人以为改过了。
  it('内存里那份也就地改了，接口立刻反映新值', () => {
    const { config } = written();

    writeSettings(config, { ...ok, station: { myCallsign: 'BG0CG', myQth: '都江堰' } });

    assert.equal(config.station.myQth, '都江堰');
  });

  it('不碰 dbPath、密钥和 recordingsDir，注释键也留着', () => {
    const { path, config } = written();

    writeSettings(config, ok);

    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(raw['//note'], '别弄丢我');
    assert.equal(raw.dbPath, './openheard.db');
    assert.equal(raw.sessionSecret, 'y'.repeat(40));
    assert.equal((raw.analog as { recordingsDir: string }).recordingsDir, './rec');
  });

  it('权限还是 600，里面有密钥', () => {
    const { path, config } = written();

    writeSettings(config, ok);

    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});
