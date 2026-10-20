import { describe, expect, it } from 'vitest';
import { aiDefaults, mapDefaults, resolveAiConfig, resolveMapConfig } from './ai-config.ts';

describe('resolveAiConfig', () => {
  it('没写这一段就是缺省值，没有问题', () => {
    const r = resolveAiConfig(undefined);
    expect(r.problems).toEqual([]);
    expect(r.config).toEqual(aiDefaults());
    expect(r.config.enabled).toBe(false);
  });

  it('只写了几个键，其余补缺省', () => {
    const r = resolveAiConfig({ enabled: true, asr: { language: 'en' } });
    expect(r.problems).toEqual([]);
    expect(r.config.enabled).toBe(true);
    expect(r.config.asr.language).toBe('en');
    expect(r.config.asr.binPath).toBe(aiDefaults().asr.binPath);
    expect(r.config.text.port).toBe(8091);
  });

  it('提供方不在枚举里就报', () => {
    const r = resolveAiConfig({ asr: { provider: 'whisper' }, vad: { provider: 'cloud' } });
    expect(r.problems.join('|')).toContain('ai.asr.provider 只能是');
    expect(r.problems.join('|')).toContain('ai.vad.provider 只能是');
  });

  it('云端要 baseUrl、model 和 apiKey', () => {
    const r = resolveAiConfig({ asr: { provider: 'chat-audio' }, text: { provider: 'off' } });
    expect(r.problems).toEqual(['ai.asr.baseUrl 必填', 'ai.asr.model 必填', 'ai.asr.apiKey 必填']);
    const ok = resolveAiConfig({
      asr: { provider: 'chat-audio', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-asr', apiKey: 'k' },
    });
    expect(ok.problems).toEqual([]);
  });

  it('识别开着时语言不能是空的，关着时不管', () => {
    const r = resolveAiConfig({ asr: { language: ' ' }, text: { provider: 'off' } });
    expect(r.problems).toEqual(['ai.asr.language 必填']);
    const off = resolveAiConfig({ asr: { provider: 'off', language: '' }, text: { provider: 'off' } });
    expect(off.problems).toEqual([]);
  });

  it('baseUrl 不是 http 地址就报', () => {
    const r = resolveAiConfig({ text: { provider: 'openai-chat', baseUrl: 'ftp://x', model: 'm', apiKey: 'k' } });
    expect(r.problems).toEqual(['ai.text.baseUrl 要是 http 或 https 地址']);
  });

  it('识别关着时提取也要关', () => {
    const r = resolveAiConfig({ asr: { provider: 'off' } });
    expect(r.problems).toEqual(['ai.asr 关着时 ai.text 也要关']);
    expect(resolveAiConfig({ asr: { provider: 'off' }, text: { provider: 'off' } }).problems).toEqual([]);
  });

  it('类型和范围', () => {
    const r = resolveAiConfig({
      enabled: 'yes',
      vad: { threshold: 1.5 },
      text: { port: 70000, idleUnloadS: 0, extraBody: [] },
    });
    expect(r.problems).toContain('ai.enabled 要是 true 或 false');
    expect(r.problems).toContain('ai.vad.threshold 要是 大于 0 小于 1 的数');
    expect(r.problems).toContain('ai.text.port 要是 1 到 65535 的整数');
    expect(r.problems).toContain('ai.text.idleUnloadS 要是 不小于 1 的整数');
    expect(r.problems).toContain('ai.text.extraBody 要是对象');
  });

  it('ai 不是对象', () => {
    expect(resolveAiConfig('x').problems).toEqual(['ai 要是对象']);
    expect(resolveAiConfig([]).problems).toEqual(['ai 要是对象']);
  });

  it('extraBody 原样带出来', () => {
    const r = resolveAiConfig({
      text: { provider: 'openai-chat', baseUrl: 'https://x', model: 'm', apiKey: 'k', extraBody: { thinking: { type: 'disabled' } } },
    });
    expect(r.config.text.extraBody).toEqual({ thinking: { type: 'disabled' } });
  });
});

describe('resolveMapConfig', () => {
  it('缺省是不用地图', () => {
    expect(resolveMapConfig(undefined)).toEqual({ config: mapDefaults(), problems: [] });
  });

  it('高德要 key 和安全密钥两样', () => {
    expect(resolveMapConfig({ provider: 'amap', amapKey: 'k' }).problems).toEqual(['map.amapSecurityCode 必填']);
    expect(resolveMapConfig({ provider: 'amap', amapKey: 'k', amapSecurityCode: 's' }).problems).toEqual([]);
  });

  it('OpenStreetMap 不要 key', () => {
    expect(resolveMapConfig({ provider: 'osm' }).problems).toEqual([]);
  });

  it('provider 不对就报', () => {
    expect(resolveMapConfig({ provider: 'google' }).problems).toEqual(['map.provider 只能是 amap、osm、none']);
  });
});
