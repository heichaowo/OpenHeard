import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { checkQueries } from './core.ts';
import type { Channel, StationDefaults } from './core.ts';
import type { Config, Query } from './config.ts';

/**
 * 人可以在界面上改的那几项。
 *
 * 改不了的留在文件里：`dbPath`、`host`、三个密钥、`recordingsDir`。它们要么
 * 一改就要重启整套，要么改错了就把自己关在门外，不该放在手机上点。
 */
export interface Settings {
  station: StationDefaults;
  channels: Channel[];
  queries: Query[];
  analog?: AnalogSettings;
}

export interface AnalogSettings {
  freqMhz: number;
  channel: string;
  gainDb?: number;
  /** 本台的 MDC-1200 unit ID，十六进制字符串。 */
  myUnitId?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 业余 2m 和 70cm。和 core 的 bandOf 同一个范围。 */
const inBand = (f: number) => (f >= 144 && f <= 148) || (f >= 420 && f <= 450);

export function checkSettings(raw: unknown): string[] {
  if (!isObject(raw)) return ['设置的顶层不是对象'];
  const problems: string[] = [];

  if (!isObject(raw.station)) problems.push('station 必填');

  if (!Array.isArray(raw.channels)) {
    problems.push('channels 必填，可以是空数组');
  } else {
    raw.channels.forEach((c, i) => {
      if (!isObject(c)) return problems.push(`channels[${i}] 不是对象`);
      if (typeof c.name !== 'string' || c.name === '') problems.push(`channels[${i}].name 必填`);
      if (typeof c.freqMhz !== 'number' || !inBand(c.freqMhz)) {
        problems.push(`channels[${i}].freqMhz 要在 2m 或 70cm 段内`);
      }
      if (c.mode !== 'FM' && c.mode !== 'DMR') problems.push(`channels[${i}].mode 只能是 FM 或 DMR`);
    });
  }

  problems.push(...checkQueries(raw.queries));

  if (raw.analog !== undefined && raw.analog !== null) {
    const a = raw.analog;
    if (!isObject(a)) {
      problems.push('analog 不是对象');
    } else {
      // 调谐器调不到的频率写进去，守护进程会起来就崩，然后每 5 秒重来一次。
      if (typeof a.freqMhz !== 'number' || !inBand(a.freqMhz)) {
        problems.push('analog.freqMhz 要在 2m 或 70cm 段内');
      }
      if (typeof a.channel !== 'string' || a.channel === '') problems.push('analog.channel 必填');
      if (a.gainDb !== undefined && typeof a.gainDb !== 'number') problems.push('analog.gainDb 要是数字');
      if (a.myUnitId !== undefined && !/^[0-9a-fA-F]{1,4}$/.test(String(a.myUnitId))) {
        problems.push('analog.myUnitId 要是 1 到 4 位十六进制，例如 6460');
      }
    }
  }

  return problems;
}

/** 从当前配置里挑出可改的那部分，给界面填表用。 */
export function settingsOf(config: Config, analog?: AnalogSettings): Settings {
  return {
    station: config.station,
    channels: config.channels,
    queries: config.queries,
    analog,
  };
}

/**
 * 把设置写回配置文件，并且就地更新内存里那份。
 *
 * 必须落盘。只改内存的话，launchd 下一次重启就悄悄变回去，而人以为改过了。
 * 先写临时文件再 rename，中途断电不会留下半个 JSON 让两个进程都起不来。
 * 文件里有密钥，所以权限还是 600。
 */
export function writeSettings(config: Config, next: Settings): void {
  const raw = JSON.parse(readFileSync(config.path, 'utf8')) as Record<string, unknown>;

  raw.station = next.station;
  raw.channels = next.channels;
  raw.queries = next.queries;
  if (next.analog !== undefined) {
    // recordingsDir 是路径，不在界面上改，保留文件里原来那个。
    const before = isObject(raw.analog) ? raw.analog : {};
    raw.analog = { ...before, ...next.analog };
  }

  const tmp = `${config.path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, config.path);

  // 内存里这份是 createStore 按引用拿着的，就地改它，接口立刻反映新值。
  config.station = next.station;
  config.channels = next.channels;
  config.queries = next.queries;
}
