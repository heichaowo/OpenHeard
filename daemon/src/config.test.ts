import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from './config.ts';

const base = {
  dmrId: 4616460,
  ingestToken: 'x'.repeat(32),
  queries: [
    { key: 'dst:46001', rule: { id: 'DestinationID', operator: 'equal', value: 46001 }, amount: 200, intervalS: 900 },
  ],
};

const load = (analog: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-dcfg-'));
  const path = join(dir, 'openheard.config.json');
  writeFileSync(path, JSON.stringify({ ...base, analog }));
  return loadConfig(path);
};

describe('analog 的信道表', () => {
  it('一支接收机守两个信道', () => {
    const r = load({
      channels: [
        { freqMhz: 438.5, channel: '438.500 中继' },
        { freqMhz: 438.975, channel: '438.975' },
      ],
    });
    assert.ok(r.ok);
    assert.deepEqual(
      r.config.analog?.channels.map((c) => c.freqMhz),
      [438.5, 438.975],
    );
  });

  // 已经装出去的配置还是只写一个频率。
  it('旧写法读成只有一个信道的表', () => {
    const r = load({ freqMhz: 438.5, channel: '438.500 中继' });
    assert.ok(r.ok);
    assert.deepEqual(r.config.analog?.channels, [{ freqMhz: 438.5, channel: '438.500 中继' }]);
  });

  it('一支接收机收不下、信道重名、一个信道都没有，都不收', () => {
    const wide = load({
      channels: [
        { freqMhz: 438.0, channel: 'a' },
        { freqMhz: 440.0, channel: 'b' },
      ],
    });
    assert.ok(!wide.ok && wide.problems.some((p) => p.includes('最多 1.8 MHz')));

    const same = load({
      channels: [
        { freqMhz: 438.5, channel: 'a' },
        { freqMhz: 438.975, channel: 'a' },
      ],
    });
    assert.ok(!same.ok && same.problems.some((p) => p.includes('不能重复')));

    assert.equal(load({ channels: [] }).ok, false);

    // 以前守护进程不查波段，设置页存不进去的频率，手改配置文件就能让它调过去。
    const fm = load({ channels: [{ freqMhz: 100, channel: 'a' }] });
    assert.ok(!fm.ok && fm.problems.some((p) => p.includes('2m 或 70cm')));
  });
});

describe('开关的生效值', () => {
  const withRaw = (extra: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'openheard-dcfg-'));
    const path = join(dir, 'openheard.config.json');
    writeFileSync(path, JSON.stringify({ ...base, ...extra }));
    return loadConfig(path);
  };

  it('BrandMeister 关着时 queries 生效值是空数组，不管文件里配了多少条', () => {
    const r = withRaw({ brandmeisterEnabled: false });
    assert.ok(r.ok);
    assert.deepEqual(r.config.queries, []);
  });

  it('BrandMeister 关着、queries 缺失也不算错', () => {
    const r = withRaw({ brandmeisterEnabled: false, queries: undefined });
    assert.ok(r.ok);
    assert.deepEqual(r.config.queries, []);
  });

  it('BrandMeister 关着，传了的 queries 条目还是照样验', () => {
    const r = withRaw({
      brandmeisterEnabled: false,
      queries: [{ key: 'dst:91', rule: { id: 'DestinationID', operator: 'equal' } }], // 缺 amount、intervalS、value
    });
    assert.equal(r.ok, false);
  });

  it('BrandMeister 缺省是开的', () => {
    const r = withRaw({});
    assert.ok(r.ok);
    assert.equal(r.config.queries.length, 1);
  });

  it('模拟守听关着时生效值是 undefined，信道表不读也不验', () => {
    const r = withRaw({ analog: { enabled: false, channels: [{ freqMhz: 100, channel: 'x' }] } });
    assert.ok(r.ok);
    assert.equal(r.config.analog, undefined);
  });

  it('模拟守听关着、压根没有信道表也不算错', () => {
    const r = withRaw({ analog: { enabled: false } });
    assert.ok(r.ok);
    assert.equal(r.config.analog, undefined);
  });

  it('模拟守听开着（缺省或者显式 true）时照常读信道表', () => {
    const on = withRaw({ analog: { channels: [{ freqMhz: 438.5, channel: 'a' }] } });
    assert.ok(on.ok);
    assert.equal(on.config.analog?.channels.length, 1);

    const explicit = withRaw({ analog: { enabled: true, channels: [{ freqMhz: 438.5, channel: 'a' }] } });
    assert.ok(explicit.ok);
    assert.equal(explicit.config.analog?.channels.length, 1);
  });
});
