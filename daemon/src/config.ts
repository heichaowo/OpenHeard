import { readFileSync } from 'node:fs';
import type { Rule } from './brandmeister.ts';

export interface Query {
  key: string;
  rule: Rule;
  amount: number;
  intervalS: number;
}

/** 模拟守听。缺这一段就只跑数字侧。 */
export interface AnalogConfig {
  freqMhz: number;
  channel: string;
  gainDb: number;
  /** 本台的 MDC-1200 unit ID，十六进制字符串。没有就判不出哪次是本台。 */
  unitId?: string;
  recordingsDir: string;
}

export interface DaemonConfig {
  dmrId: number;
  queries: Query[];
  apiUrl: string;
  ingestToken: string;
  spoolDir: string;
  analog?: AnalogConfig;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

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
  const queries = raw.queries;
  const token = raw.ingestToken;

  if (typeof dmrId !== 'number' || dmrId <= 0) {
    problems.push('dmrId 必填。没有它就判不出哪次发射是本台的，队列会一直是空的');
  }
  if (typeof token !== 'string' || token.length < 16) problems.push('ingestToken 必填');
  if (!Array.isArray(queries) || queries.length === 0) problems.push('queries 必填，至少一条');

  if (problems.length > 0) return { ok: false, problems };

  const a = raw.analog;
  let analog: AnalogConfig | undefined;
  if (isObject(a)) {
    if (typeof a.freqMhz !== 'number' || typeof a.channel !== 'string') {
      problems.push('analog 要有 freqMhz 和 channel');
    } else {
      analog = {
        freqMhz: a.freqMhz,
        channel: a.channel,
        gainDb: typeof a.gainDb === 'number' ? a.gainDb : 32.8,
        unitId: typeof a.unitId === 'string' ? a.unitId : undefined,
        recordingsDir: typeof a.recordingsDir === 'string' ? a.recordingsDir : './recordings',
      };
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    config: {
      analog,
      dmrId: dmrId as number,
      queries: queries as Query[],
      apiUrl: typeof raw.apiUrl === 'string' ? raw.apiUrl : 'http://127.0.0.1:3000',
      ingestToken: token as string,
      spoolDir: typeof raw.spoolDir === 'string' ? raw.spoolDir : './spool',
    },
  };
}
