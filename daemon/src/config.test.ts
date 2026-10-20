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

describe('ai 的生效值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-dcfg-'));
  const withRaw = (extra: Record<string, unknown>) => {
    const path = join(dir, 'openheard.config.json');
    writeFileSync(path, JSON.stringify({ ...base, ...extra }));
    return loadConfig(path);
  };

  it('没写、enabled 缺省或者是 false：undefined，不是错', () => {
    for (const ai of [undefined, {}, { enabled: false }]) {
      const r = withRaw({ ai });
      assert.ok(r.ok);
      assert.equal(r.config.ai, undefined);
      assert.equal(r.config.aiProblem, undefined);
    }
  });

  it('只写 enabled:true：全本机，路径缺省，相对路径按配置文件算，裸名字不动', () => {
    const r = withRaw({ ai: { enabled: true } });
    assert.ok(r.ok);
    const ai = r.config.ai!;
    assert.equal(ai.vad.provider, 'local');
    assert.equal(ai.vad.binPath, '/opt/homebrew/bin/whisper-vad-speech-segments');
    assert.equal(ai.vad.modelPath, join(dir, 'models/ggml-silero-v5.1.2.bin'));
    assert.equal(ai.vad.threshold, 0.5);
    assert.equal(ai.asr.provider, 'local');
    assert.equal(ai.asr.binPath, '/opt/homebrew/bin/whisper-cli');
    assert.equal(ai.asr.modelPath, join(dir, 'models/ggml-large-v3-turbo-q5_0.bin'));
    assert.equal(ai.asr.language, 'zh');
    assert.equal(ai.asr.prompt, '');
    assert.deepEqual(ai.asr.extraBody, {});
    assert.equal(ai.text.provider, 'local');
    assert.equal(ai.text.binPath, '/opt/homebrew/bin/llama-server');
    assert.equal(ai.text.modelPath, join(dir, 'models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf'));
    assert.equal(ai.text.port, 8091);
    assert.equal(ai.text.idleUnloadS, 120);

    const rel = withRaw({ ai: { enabled: true, asr: { binPath: 'whisper-cli' }, text: { binPath: './bin/llama-server' } } });
    assert.ok(rel.ok);
    assert.equal(rel.config.ai!.asr.binPath, 'whisper-cli');
    assert.equal(rel.config.ai!.text.binPath, join(dir, 'bin/llama-server'));
  });

  // 守听关着（接收机拔了）而识别开着，要把旧录音补做完
  it('recordingsDir 和 api 一个算法：没有 analog 或者 analog 关着都有值', () => {
    const none = withRaw({ ai: { enabled: true } });
    assert.ok(none.ok);
    assert.equal(none.config.ai!.recordingsDir, join(dir, 'recordings'));

    const off = withRaw({ ai: { enabled: true }, analog: { enabled: false, recordingsDir: './rec2' } });
    assert.ok(off.ok);
    assert.equal(off.config.analog, undefined);
    assert.equal(off.config.ai!.recordingsDir, join(dir, 'rec2'));

    const on = withRaw({
      ai: { enabled: true },
      analog: { channels: [{ freqMhz: 438.5, channel: 'a' }], recordingsDir: '/var/rec' },
    });
    assert.ok(on.ok);
    assert.equal(on.config.ai!.recordingsDir, '/var/rec');
    assert.equal(on.config.analog!.recordingsDir, '/var/rec');
  });

  it('云端识别和提取：字段、extraBody 原样带过来', () => {
    const r = withRaw({
      ai: {
        enabled: true,
        vad: { provider: 'off' },
        asr: {
          provider: 'chat-audio',
          baseUrl: 'https://api.xiaomimimo.com/v1',
          model: 'mimo-v2.5-asr',
          apiKey: 'sk-a',
          extraBody: { stream: false },
        },
        text: {
          provider: 'openai-chat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          apiKey: 'sk-b',
          extraBody: { thinking: { type: 'disabled' } },
        },
      },
    });
    assert.ok(r.ok);
    const ai = r.config.ai!;
    assert.equal(ai.vad.provider, 'off');
    assert.equal(ai.asr.model, 'mimo-v2.5-asr');
    assert.deepEqual(ai.text.extraBody, { thinking: { type: 'disabled' } });
  });

  // 识别是可选的。写坏了拖垮采集，比没有识别糟得多
  it('写坏了：ai 是 undefined，带上原因，配置本身照样通过（不退出）', () => {
    const bad: [string, unknown, RegExp][] = [
      ['不是对象', { enabled: true, vad: 3 }, /ai\.vad 要是对象/],
      ['不认识的 provider', { enabled: true, asr: { provider: 'whisperx' } }, /ai\.asr\.provider 只能是/],
      ['云端缺 key', { enabled: true, text: { provider: 'openai-chat', baseUrl: 'https://x.example/v1', model: 'm' } }, /ai\.text\.apiKey 必填/],
      ['云端缺地址', { enabled: true, asr: { provider: 'chat-audio', model: 'm', apiKey: 'k' } }, /ai\.asr\.baseUrl/],
      ['云端缺 model', { enabled: true, asr: { provider: 'openai-transcriptions', baseUrl: 'https://x.example/v1', apiKey: 'k' } }, /ai\.asr\.model 必填/],
      ['extraBody 不是对象', { enabled: true, text: { extraBody: [] } }, /extraBody 要是对象/],
      ['阈值越界', { enabled: true, vad: { threshold: 1.5 } }, /threshold/],
      ['端口', { enabled: true, text: { port: 70000 } }, /ai\.text\.port/],
      ['闲置时间', { enabled: true, text: { idleUnloadS: 0 } }, /idleUnloadS/],
      ['语言是空的', { enabled: true, asr: { language: '' } }, /ai\.asr\.language 必填/],
      ['识别关着提取开着', { enabled: true, asr: { provider: 'off' } }, /ai\.asr 关着时 ai\.text 也要关/],
    ];
    for (const [name, ai, problem] of bad) {
      const r = withRaw({ ai });
      assert.ok(r.ok, `${name}：配置本身不该失败`);
      assert.equal(r.config.ai, undefined, name);
      assert.match(r.config.aiProblem!, problem, name);
    }
    const notObject = withRaw({ ai: 'yes' });
    assert.ok(notObject.ok);
    assert.match(notObject.config.aiProblem!, /ai 要是对象/);
  });

  // 和 api 的 loadConfig 一个口径：关着的段写坏了也报，打开那一刻才会撞上
  it('enabled 是 false 但段写坏了：ai 是 undefined，原因照报', () => {
    const r = withRaw({ ai: { enabled: false, asr: { provider: 'bogus' } } });
    assert.ok(r.ok);
    assert.equal(r.config.ai, undefined);
    assert.match(r.config.aiProblem!, /ai\.asr\.provider 只能是/);
  });

  it('三步都关着：当成没开，不报错', () => {
    const r = withRaw({ ai: { enabled: true, vad: { provider: 'off' }, asr: { provider: 'off' }, text: { provider: 'off' } } });
    assert.ok(r.ok);
    assert.equal(r.config.ai, undefined);
    assert.equal(r.config.aiProblem, undefined);
  });

  it('只开人声判断、识别关着提取也关着：合法', () => {
    const r = withRaw({ ai: { enabled: true, asr: { provider: 'off' }, text: { provider: 'off' } } });
    assert.ok(r.ok);
    assert.equal(r.config.ai?.vad.provider, 'local');
  });
});
