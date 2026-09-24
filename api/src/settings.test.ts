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
  station: { myCallsign: 'BG0CG', networkFreqMhz: 439.525 },
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
  // 网络会话没有射频频率，全靠这个数记账。缺了的话数字侧每一段都没有波段，
  // 于是永远停在待确认队列里，而界面上只说「还缺波段」。
  it('有查询却没填网络记账频率就拦住', () => {
    const problems = checkSettings({ ...ok, station: { myCallsign: 'BG0CG' } });
    assert.ok(problems.some((p) => p.includes('网络记账频率')));
    assert.deepEqual(checkSettings({ ...ok, station: { networkFreqMhz: null } }).length > 0, true);
  });

  it('没有查询时不强求网络记账频率', () => {
    assert.deepEqual(checkSettings({ ...ok, queries: [], station: { myCallsign: 'BG0CG' } }), [
      'queries 必填，至少一条',
    ]);
  });

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

  // 打开的门限比关闭的低，中间那段是回差。两个挨太近，信号刚过线就会开关抖个不停。
  it('静噪余量要讲得通', () => {
    const with_ = (o: Record<string, unknown>) =>
      checkSettings({ ...ok, analog: { ...ok.analog, ...o } });
    assert.deepEqual(with_({ openMarginDb: 8, closeMarginDb: 4 }), []);
    assert.ok(with_({ openMarginDb: 8, closeMarginDb: 7 }).length > 0);
    assert.ok(with_({ openMarginDb: 0 }).length > 0);
    assert.ok(with_({ openMarginDb: 200 }).length > 0);
    assert.ok(with_({ closeMarginDb: 'x' }).length > 0);
  });

  // 只提交一个余量的话，它会和文件里原来那个凑成一对，而那一对从没验过。
  it('只提交一个余量时，按合并之后的那一对验', () => {
    const only = (o: Record<string, unknown>) =>
      checkSettings({ ...ok, analog: { freqMhz: 145.5, channel: 'x', ...o } }, {
        freqMhz: 145.5,
        channel: 'x',
        openMarginDb: 12,
        closeMarginDb: 7,
      });
    // 只改打开，和原来的 close 7 凑成 8/7，差 1，不行
    assert.ok(only({ openMarginDb: 8 }).length > 0);
    // 只改打开到 10，和 7 凑成差 3，可以
    assert.deepEqual(only({ openMarginDb: 10 }), []);
    // 只改关闭到 11，和原来的 open 12 凑成差 1，不行
    assert.ok(only({ closeMarginDb: 11 }).length > 0);
  });

  it('unit id 要是十六进制', () => {
    assert.ok(checkSettings({ ...ok, analog: { ...ok.analog, myUnitId: 'XYZQ' } }).length > 0);
    assert.ok(checkSettings({ ...ok, analog: { ...ok.analog, myUnitId: '12345' } }).length > 0);
    assert.deepEqual(checkSettings({ ...ok, analog: { ...ok.analog, myUnitId: '6460' } }), []);
  });

  // antd 的数字框清空后给 null，文本框给空串。把它们当成填错了，整张表就存不了。
  it('清空的可选项当没填，不拦', () => {
    const cleared = { ...ok.analog, gainDb: null, myUnitId: '', openMarginDb: null, closeMarginDb: null };
    assert.deepEqual(checkSettings({ ...ok, analog: cleared }), []);
  });

  it('清空一个余量就是回到缺省值，按缺省值去凑那一对', () => {
    const clear = (k: string) =>
      checkSettings({ ...ok, analog: { ...ok.analog, [k]: null } }, {
        freqMhz: 145.5,
        channel: 'x',
        openMarginDb: 20,
        closeMarginDb: 18,
      });
    // 关闭回到 7，和 20 差 13，可以
    assert.deepEqual(clear('closeMarginDb'), []);
    // 打开回到 12，和 18 凑不成回差
    assert.ok(clear('openMarginDb').length > 0);
  });

  // 没配过模拟守听时，表单里那几格没填，照样会交一个空的 analog 上来。
  it('一个全空的 analog 不算要开始配，不拦', () => {
    assert.deepEqual(checkSettings({ ...ok, analog: {} }), []);
    assert.deepEqual(checkSettings({ ...ok, analog: { freqMhz: null, channel: '' } }), []);
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

    writeSettings(config, {
      ...ok,
      station: { myCallsign: 'BG0CG', myQth: '都江堰', networkFreqMhz: 439.525 },
    });

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

  it('清空的那一格去掉键，缺省值生效', () => {
    const { path, config } = written({ analog: { ...base.analog, gainDb: 40 } });

    writeSettings(config, { ...ok, analog: { ...ok.analog, gainDb: null } } as unknown as Settings);

    const raw = JSON.parse(readFileSync(path, 'utf8')) as { analog: Record<string, unknown> };
    assert.equal('gainDb' in raw.analog, false);
    assert.equal(raw.analog.recordingsDir, './rec');
  });

  it('没配过模拟守听时，全空的 analog 不写进文件', () => {
    const { path, config } = written({ analog: undefined });

    writeSettings(config, { ...ok, analog: {} } as unknown as Settings);

    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(raw.analog, undefined);
    assert.equal(config.analog, undefined);
  });

  it('权限还是 600，里面有密钥', () => {
    const { path, config } = written();

    writeSettings(config, ok);

    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});
