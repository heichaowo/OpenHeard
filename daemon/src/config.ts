import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Rule } from './brandmeister.ts';
import { checkQueries } from '../../core/src/queries.ts';
import { readAnalogChannels } from './core.ts';

export interface Query {
  key: string;
  rule: Rule;
  amount: number;
  intervalS: number;
}

/** 模拟守听。缺这一段就只跑数字侧。 */
export interface AnalogConfig {
  /** 同一支接收机守的几个信道。 */
  channels: { freqMhz: number; channel: string }[];
  gainDb: number;
  /** 本台的 MDC-1200 unit ID，十六进制字符串。没有就判不出哪次是本台。 */
  myUnitId?: string;
  /**
   * 静噪打开的余量，dB。噪声比静默基准低这么多就算有载波。
   *
   * 各地的噪声本底和天线不一样，这个数是按部署调的，写死在代码里等于
   * 把一次部署的猜测烤进去。调大了弱信号永远打不开，调小了噪声起伏
   * 就会伪造出一堆发射，把队列和磁盘塞满。
   */
  openMarginDb: number;
  /** 静噪关闭的余量，dB。比打开那个小，中间那段是回差。 */
  closeMarginDb: number;
  recordingsDir: string;
}

/** 人声判断。只在本机跑，或者关掉。 */
export interface VadConfig {
  provider: 'local' | 'off';
  /** 不带 `/` 的名字去 PATH 里找，带 `/` 的相对配置文件所在目录。 */
  binPath: string;
  modelPath: string;
  threshold: number;
}

export interface AsrConfig {
  provider: 'local' | 'openai-transcriptions' | 'chat-audio' | 'off';
  binPath: string;
  modelPath: string;
  language: string;
  prompt: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 最后合并进云端请求体，厂商各自的开关（关思考、限输出）都靠它，代码里不认厂商。 */
  extraBody: Record<string, unknown>;
}

export interface TextConfig {
  provider: 'local' | 'openai-chat' | 'off';
  binPath: string;
  modelPath: string;
  port: number;
  idleUnloadS: number;
  baseUrl: string;
  model: string;
  apiKey: string;
  extraBody: Record<string, unknown>;
}

/** 语音识别。生效值：关着或者写坏了是 undefined，不起识别。 */
export interface AiConfig {
  /** 和 api 的 recordingsDirOf 同一个算法：有没有开模拟守听都有值。 */
  recordingsDir: string;
  vad: VadConfig;
  asr: AsrConfig;
  text: TextConfig;
}

export interface DaemonConfig {
  dmrId: number;
  /** 生效值：BrandMeister 关着时是空数组，不管文件里原来配了多少条。 */
  queries: Query[];
  apiUrl: string;
  ingestToken: string;
  spoolDir: string;
  /** 生效值：模拟守听关着（或者压根没配）时是 undefined，不起 rtl_sdr。 */
  analog?: AnalogConfig;
  /** 生效值：`ai.enabled` 不是 true、没有一步开着或者写坏了都是 undefined。 */
  ai?: AiConfig;
  /** `ai` 写坏了的原因。只记日志，不挡采集：识别是可选的，不能拖垮必需的那一半。 */
  aiProblem?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);

/**
 * 读 `ai`。写坏了给 undefined 和原因，不给 problems：识别是可选的，
 * 为它退出会让 launchd 每 30 秒重启一次，采集跟着停。
 * 严格的校验在 api 的设置页上，那里拦得住手填的值；这里只管手改文件的情况。
 */
export function readAi(
  raw: unknown,
  recordingsDir: string,
  near: (p: string) => string,
): { ai?: AiConfig; problem?: string } {
  if (raw === undefined) return {};
  if (!isObject(raw)) return { problem: 'ai 要是对象' };
  if (raw.enabled !== true) return {};

  const bad: string[] = [];
  const section = (name: string): Record<string, unknown> => {
    const v = raw[name];
    if (v === undefined) return {};
    if (isObject(v)) return v;
    bad.push(`ai.${name} 要是对象`);
    return {};
  };
  const pick = <T extends string>(name: string, v: unknown, allowed: readonly T[]): T => {
    const given = v === undefined ? allowed[0]! : v;
    if (allowed.includes(given as T)) return given as T;
    bad.push(`ai.${name}.provider 只能是 ${allowed.join('、')}`);
    return allowed[0]!;
  };
  // 路径：裸名字留着去 PATH 找，带 / 的相对配置文件。
  const bin = (v: unknown, fallback: string) => {
    const p = str(v, fallback);
    return p.includes('/') ? near(p) : p;
  };
  const body = (name: string, v: unknown) => {
    if (v === undefined) return {};
    if (isObject(v)) return v;
    bad.push(`ai.${name}.extraBody 要是对象`);
    return {};
  };
  const cloud = (name: string, c: { baseUrl: string; model: string; apiKey: string }) => {
    if (!/^https?:\/\/\S+$/.test(c.baseUrl)) bad.push(`ai.${name}.baseUrl 要是 http(s) 地址`);
    if (c.model === '') bad.push(`ai.${name}.model 必填`);
    if (c.apiKey === '') bad.push(`ai.${name}.apiKey 必填`);
  };

  const v = section('vad');
  const vad: VadConfig = {
    provider: pick('vad', v.provider, ['local', 'off']),
    binPath: bin(v.binPath, '/opt/homebrew/bin/whisper-vad-speech-segments'),
    modelPath: near(str(v.modelPath, './models/ggml-silero-v5.1.2.bin')),
    threshold: typeof v.threshold === 'number' ? v.threshold : 0.5,
  };
  if (!(vad.threshold > 0 && vad.threshold < 1)) bad.push('ai.vad.threshold 要在 0 和 1 之间');

  const a = section('asr');
  const asr: AsrConfig = {
    provider: pick('asr', a.provider, ['local', 'openai-transcriptions', 'chat-audio', 'off']),
    binPath: bin(a.binPath, '/opt/homebrew/bin/whisper-cli'),
    modelPath: near(str(a.modelPath, './models/ggml-large-v3-turbo-q5_0.bin')),
    language: str(a.language, 'zh'),
    prompt: str(a.prompt, ''),
    baseUrl: str(a.baseUrl, ''),
    model: str(a.model, ''),
    apiKey: str(a.apiKey, ''),
    extraBody: body('asr', a.extraBody),
  };
  if (asr.language === '') bad.push('ai.asr.language 不能是空的');
  if (asr.provider === 'openai-transcriptions' || asr.provider === 'chat-audio') cloud('asr', asr);

  const t = section('text');
  const text: TextConfig = {
    provider: pick('text', t.provider, ['local', 'openai-chat', 'off']),
    binPath: bin(t.binPath, '/opt/homebrew/bin/llama-server'),
    modelPath: near(str(t.modelPath, './models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf')),
    port: typeof t.port === 'number' ? t.port : 8091,
    idleUnloadS: typeof t.idleUnloadS === 'number' ? t.idleUnloadS : 120,
    baseUrl: str(t.baseUrl, ''),
    model: str(t.model, ''),
    apiKey: str(t.apiKey, ''),
    extraBody: body('text', t.extraBody),
  };
  if (text.provider === 'local') {
    if (!Number.isInteger(text.port) || text.port < 1 || text.port > 65535) bad.push('ai.text.port 要是端口号');
    if (!Number.isInteger(text.idleUnloadS) || text.idleUnloadS < 1) bad.push('ai.text.idleUnloadS 要是正整数');
  }
  if (text.provider === 'openai-chat') cloud('text', text);
  // 没有转写就没东西可提取。放行的话文字模型拿到空文本，会回 noise，
  // 有人声的发射全被标成无意义藏起来。
  if (asr.provider === 'off' && text.provider !== 'off') bad.push('ai.asr 关着时 ai.text 也要关');

  if (bad.length > 0) return { problem: `ai 写得不对，识别没起：${bad.join('，')}` };
  // 三步都关着没有事可做。当成没开，不报错。
  if (vad.provider === 'off' && asr.provider === 'off' && text.provider === 'off') return {};
  return { ai: { recordingsDir, vad, asr, text } };
}

export type ConfigResult =
  | { ok: true; config: DaemonConfig }
  | { ok: false; problems: string[] };

/**
 * 和 api/ 读同一个文件，但只取自己要的那几项。
 *
 * 两边各自解析，不共用一个模块，这样两个可执行体互不依赖。
 */
export function loadConfig(path: string): ConfigResult {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, problems: [`读不了配置 ${path}：${(e as Error).message}`] };
  }

  const problems: string[] = [];
  const dmrId = raw.dmrId;
  const token = raw.ingestToken;
  // 缺省开。关着时 queries 可以是空的或者缺失，文件里原来配的那些不用管。
  const brandmeisterEnabled = raw.brandmeisterEnabled !== false;
  const queries = raw.queries;

  if (typeof dmrId !== 'number' || dmrId <= 0) {
    problems.push('dmrId 必填。没有它就判不出哪次发射是本台的，队列会一直是空的');
  }
  if (typeof token !== 'string' || token.length < 16) problems.push('ingestToken 必填');
  problems.push(...checkQueries(queries, brandmeisterEnabled));

  if (problems.length > 0) return { ok: false, problems };

  // 相对路径按配置文件所在目录算，不按 cwd，和 api 那边一致。
  const near = (p: string) => resolve(dirname(path), p);

  const a = raw.analog;
  // 和 api 的 recordingsDirOf 同一个算法。识别要读这个目录，而守听可能是关着的
  // （接收机拔了、只补做旧录音），所以不能只在 analog 开着时才算出来。
  const recordingsDir = near(
    isObject(a) && typeof a.recordingsDir === 'string' ? a.recordingsDir : './recordings',
  );
  // 缺省开。关着时这段直接当没配过：不读也不验它的信道表，daemon 反正不会
  // 拿它去起 rtl_sdr，装了坏数据也不该拦住这台机器起来。
  const analogEnabled = isObject(a) && a.enabled !== false;
  let analog: AnalogConfig | undefined;
  if (analogEnabled) {
    // 和 api 读配置、设置页校验是同一个函数，三处收的是同一种信道表。
    const { channels, problems: bad } = readAnalogChannels(a);
    if (channels === undefined) {
      problems.push(...bad);
    } else {
      analog = {
        channels,
        gainDb: typeof a.gainDb === 'number' ? a.gainDb : 32.8,
        // 本台自己的东西一律带 my 前缀，和 myGridsquare、myQth 那些一致。
        // unitId 是改名之前的写法，已经装出去的配置还在用，所以一起认。
        myUnitId: typeof a.myUnitId === 'string'
          ? a.myUnitId
          : typeof a.unitId === 'string'
            ? a.unitId
            : undefined,
        openMarginDb: typeof a.openMarginDb === 'number' ? a.openMarginDb : 12,
        closeMarginDb: typeof a.closeMarginDb === 'number' ? a.closeMarginDb : 7,
        recordingsDir,
      };
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const { ai, problem: aiProblem } = readAi(raw.ai, recordingsDir, near);

  return {
    ok: true,
    config: {
      analog,
      ai,
      aiProblem,
      dmrId: dmrId as number,
      queries: brandmeisterEnabled ? (queries as Query[]) : [],
      apiUrl: typeof raw.apiUrl === 'string' ? raw.apiUrl : 'http://127.0.0.1:3000',
      ingestToken: token as string,
      spoolDir: near(typeof raw.spoolDir === 'string' ? raw.spoolDir : './spool'),
    },
  };
}
