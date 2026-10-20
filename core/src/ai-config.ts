/**
 * ai 和 map 两段配置的缺省值和严格校验。
 *
 * api 和 daemon 各自读同一份文件，校验放在这里，两边才不会长歪。严格校验只在
 * 设置页保存和 writeSettings 验临时文件时用，起服务读文件时用宽松的那种：
 * 可选功能写坏了，不能让 api 回 503，也不能让守护进程退出而停掉采集。
 * 所以 loadConfig 调的是下面这两个函数，出了问题就把这一段当没配，只留一句话。
 */

export type VadProvider = 'local' | 'off';
export type AsrProvider = 'local' | 'openai-transcriptions' | 'chat-audio' | 'off';
export type TextProvider = 'local' | 'openai-chat' | 'off';
export type MapProvider = 'amap' | 'osm' | 'none';

export interface AiConfig {
  enabled: boolean;
  vad: { provider: VadProvider; binPath: string; modelPath: string; threshold: number };
  asr: {
    provider: AsrProvider;
    binPath: string;
    modelPath: string;
    language: string;
    prompt: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    extraBody: Record<string, unknown>;
  };
  text: {
    provider: TextProvider;
    binPath: string;
    modelPath: string;
    port: number;
    idleUnloadS: number;
    baseUrl: string;
    model: string;
    apiKey: string;
    extraBody: Record<string, unknown>;
  };
}

export interface MapConfig {
  provider: MapProvider;
  amapKey: string;
  amapSecurityCode: string;
}

/** 文件里没写的键按这个算。路径相对配置文件，密钥没有缺省。 */
export function aiDefaults(): AiConfig {
  return {
    enabled: false,
    vad: {
      provider: 'local',
      binPath: '/opt/homebrew/bin/whisper-vad-speech-segments',
      modelPath: './models/ggml-silero-v5.1.2.bin',
      threshold: 0.5,
    },
    asr: {
      provider: 'local',
      binPath: '/opt/homebrew/bin/whisper-cli',
      modelPath: './models/ggml-large-v3-turbo-q5_0.bin',
      language: 'zh',
      prompt: '',
      baseUrl: '',
      model: '',
      apiKey: '',
      extraBody: {},
    },
    text: {
      provider: 'local',
      binPath: '/opt/homebrew/bin/llama-server',
      modelPath: './models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
      port: 8091,
      idleUnloadS: 120,
      baseUrl: '',
      model: '',
      apiKey: '',
      extraBody: {},
    },
  };
}

export function mapDefaults(): MapConfig {
  return { provider: 'none', amapKey: '', amapSecurityCode: '' };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 取一个键。没写、写了 null 都算没写，用缺省。 */
function take(src: Record<string, unknown> | undefined, key: string): unknown {
  const v = src?.[key];
  return v === null ? undefined : v;
}

/** 校验时顺手把值收下来：类型对才收，不对记一条问题并留缺省。 */
class Reader {
  problems: string[] = [];
  path: string;
  constructor(path: string) {
    this.path = path;
  }

  str(src: Record<string, unknown> | undefined, key: string, fallback: string): string {
    const v = take(src, key);
    if (v === undefined) return fallback;
    if (typeof v !== 'string') {
      this.problems.push(`${this.path}.${key} 要是文字`);
      return fallback;
    }
    return v.trim();
  }

  oneOf<T extends string>(src: Record<string, unknown> | undefined, key: string, allowed: readonly T[], fallback: T): T {
    const v = take(src, key);
    if (v === undefined) return fallback;
    if (typeof v !== 'string' || !allowed.includes(v as T)) {
      this.problems.push(`${this.path}.${key} 只能是 ${allowed.join('、')}`);
      return fallback;
    }
    return v as T;
  }

  num(src: Record<string, unknown> | undefined, key: string, fallback: number, ok: (n: number) => boolean, hint: string): number {
    const v = take(src, key);
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) {
      this.problems.push(`${this.path}.${key} 要是 ${hint}`);
      return fallback;
    }
    return v;
  }

  object(src: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
    const v = take(src, key);
    if (v === undefined) return {};
    if (!isObject(v)) {
      this.problems.push(`${this.path}.${key} 要是对象`);
      return {};
    }
    return v;
  }
}

const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/** 云端那一步要的三项：地址、模型名、key。 */
function needCloud(problems: string[], path: string, c: { baseUrl: string; model: string; apiKey: string }) {
  if (c.baseUrl === '') problems.push(`${path}.baseUrl 必填`);
  else if (!isHttpUrl(c.baseUrl)) problems.push(`${path}.baseUrl 要是 http 或 https 地址`);
  if (c.model === '') problems.push(`${path}.model 必填`);
  if (c.apiKey === '') problems.push(`${path}.apiKey 必填`);
}

function needLocal(problems: string[], path: string, c: { binPath: string; modelPath: string }) {
  if (c.binPath === '') problems.push(`${path}.binPath 必填`);
  if (c.modelPath === '') problems.push(`${path}.modelPath 必填`);
}

/**
 * 读 ai 段，补上缺省值，严格校验。没写这一段就是缺省值，不算问题。
 * 返回的 config 在有问题时仍然是一份完整的（出问题的键用缺省），调用方按 problems 决定用不用。
 */
export function resolveAiConfig(raw: unknown): { config: AiConfig; problems: string[] } {
  const d = aiDefaults();
  if (raw === undefined || raw === null) return { config: d, problems: [] };
  if (!isObject(raw)) return { config: d, problems: ['ai 要是对象'] };

  const top = new Reader('ai');
  const enabledRaw = take(raw, 'enabled');
  if (enabledRaw !== undefined && typeof enabledRaw !== 'boolean') top.problems.push('ai.enabled 要是 true 或 false');
  const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : d.enabled;

  const sub = (key: string): Record<string, unknown> | undefined => {
    const v = take(raw, key);
    if (v === undefined) return undefined;
    if (!isObject(v)) {
      top.problems.push(`ai.${key} 要是对象`);
      return undefined;
    }
    return v;
  };
  const rv = sub('vad');
  const ra = sub('asr');
  const rt = sub('text');

  const rd = new Reader('ai.vad');
  const vad: AiConfig['vad'] = {
    provider: rd.oneOf(rv, 'provider', ['local', 'off'], d.vad.provider),
    binPath: rd.str(rv, 'binPath', d.vad.binPath),
    modelPath: rd.str(rv, 'modelPath', d.vad.modelPath),
    threshold: rd.num(rv, 'threshold', d.vad.threshold, (n) => n > 0 && n < 1, '大于 0 小于 1 的数'),
  };
  const ar = new Reader('ai.asr');
  const asr: AiConfig['asr'] = {
    provider: ar.oneOf(ra, 'provider', ['local', 'openai-transcriptions', 'chat-audio', 'off'], d.asr.provider),
    binPath: ar.str(ra, 'binPath', d.asr.binPath),
    modelPath: ar.str(ra, 'modelPath', d.asr.modelPath),
    language: ar.str(ra, 'language', d.asr.language),
    prompt: ar.str(ra, 'prompt', d.asr.prompt),
    baseUrl: ar.str(ra, 'baseUrl', d.asr.baseUrl),
    model: ar.str(ra, 'model', d.asr.model),
    apiKey: ar.str(ra, 'apiKey', d.asr.apiKey),
    extraBody: ar.object(ra, 'extraBody'),
  };
  const tr = new Reader('ai.text');
  const text: AiConfig['text'] = {
    provider: tr.oneOf(rt, 'provider', ['local', 'openai-chat', 'off'], d.text.provider),
    binPath: tr.str(rt, 'binPath', d.text.binPath),
    modelPath: tr.str(rt, 'modelPath', d.text.modelPath),
    port: tr.num(rt, 'port', d.text.port, (n) => Number.isInteger(n) && n >= 1 && n <= 65535, '1 到 65535 的整数'),
    idleUnloadS: tr.num(rt, 'idleUnloadS', d.text.idleUnloadS, (n) => Number.isInteger(n) && n >= 1, '不小于 1 的整数'),
    baseUrl: tr.str(rt, 'baseUrl', d.text.baseUrl),
    model: tr.str(rt, 'model', d.text.model),
    apiKey: tr.str(rt, 'apiKey', d.text.apiKey),
    extraBody: tr.object(rt, 'extraBody'),
  };

  const problems = [...top.problems, ...rd.problems, ...ar.problems, ...tr.problems];
  // 各提供方要的字段。写错类型的键已经报过了，再报必填只会重复。
  if (vad.provider === 'local') needLocal(problems, 'ai.vad', vad);
  if (asr.provider === 'local') needLocal(problems, 'ai.asr', asr);
  else if (asr.provider !== 'off') needCloud(problems, 'ai.asr', asr);
  if (text.provider === 'local') needLocal(problems, 'ai.text', text);
  else if (text.provider !== 'off') needCloud(problems, 'ai.text', text);
  // 没有转写，文字模型拿到的是空串，会把每一次发射都判成噪声。
  if (asr.provider === 'off' && text.provider !== 'off') problems.push('ai.asr 关着时 ai.text 也要关');

  return { config: { enabled, vad, asr, text }, problems };
}

/** 读 map 段。高德要 key 和安全密钥两样都有。 */
export function resolveMapConfig(raw: unknown): { config: MapConfig; problems: string[] } {
  const d = mapDefaults();
  if (raw === undefined || raw === null) return { config: d, problems: [] };
  if (!isObject(raw)) return { config: d, problems: ['map 要是对象'] };
  const r = new Reader('map');
  const config: MapConfig = {
    provider: r.oneOf(raw, 'provider', ['amap', 'osm', 'none'], d.provider),
    amapKey: r.str(raw, 'amapKey', d.amapKey),
    amapSecurityCode: r.str(raw, 'amapSecurityCode', d.amapSecurityCode),
  };
  const problems = [...r.problems];
  if (config.provider === 'amap') {
    if (config.amapKey === '') problems.push('map.amapKey 必填');
    if (config.amapSecurityCode === '') problems.push('map.amapSecurityCode 必填');
  }
  return { config, problems };
}
