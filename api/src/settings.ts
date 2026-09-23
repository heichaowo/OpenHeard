import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { checkQueries } from './core.ts';
import type { Channel, StationDefaults } from './core.ts';
import { loadConfig } from './config.ts';
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
  /** 静噪打开的余量，dB。缺省 12。 */
  openMarginDb?: number;
  /** 静噪关闭的余量，dB。缺省 7，要比打开那个小，中间是回差。 */
  closeMarginDb?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 业余 2m 和 70cm。和 core 的 bandOf 同一个范围。 */
const inBand = (f: number) => (f >= 144 && f <= 148) || (f >= 420 && f <= 450);

export function checkSettings(raw: unknown): string[] {
  if (!isObject(raw)) return ['设置的顶层不是对象'];
  const problems: string[] = [];

  if (!isObject(raw.station)) {
    problems.push('station 必填');
  } else {
    const st = raw.station;
    for (const k of ['myCallsign', 'myGridsquare', 'myQth', 'myDevice', 'myAntenna', 'myPower']) {
      if (st[k] !== undefined && st[k] !== null && typeof st[k] !== 'string') {
        problems.push(`station.${k} 要是文字`);
      }
    }
    for (const k of ['myHeightM', 'networkFreqMhz']) {
      if (st[k] !== undefined && st[k] !== null && typeof st[k] !== 'number') {
        problems.push(`station.${k} 要是数字`);
      }
    }
    if (typeof st.networkFreqMhz === 'number' && !inBand(st.networkFreqMhz)) {
      problems.push('station.networkFreqMhz 要在 2m 或 70cm 段内');
    }
    // 网络会话没有射频频率，全靠这个数记账。缺了的话数字侧每一段都没有频率
    // 也就没有波段，于是永远停在待确认队列里，而界面上只说「还缺波段」。
    if (
      Array.isArray(raw.queries) &&
      raw.queries.length > 0 &&
      (st.networkFreqMhz === undefined || st.networkFreqMhz === null)
    ) {
      problems.push('有 BrandMeister 查询就要填网络记账频率，否则数字侧的对话都缺频率和波段，确认不了');
    }
  }

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

      const open = a.openMarginDb;
      const close = a.closeMarginDb;
      for (const [k, v] of [
        ['openMarginDb', open],
        ['closeMarginDb', close],
      ] as const) {
        if (v !== undefined && (typeof v !== 'number' || v <= 0 || v > 60)) {
          problems.push(`analog.${k} 要是 0 到 60 之间的数字`);
        }
      }
      // 打开比关闭低，中间那段是回差。两个挨太近的话，信号刚过线就会开关抖个不停。
      if (typeof open === 'number' && typeof close === 'number' && open - close < 2) {
        problems.push('analog.openMarginDb 要比 closeMarginDb 至少大 2，中间那段是回差');
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

  // 表单里清空一格给的是 null，不是「没这一项」。原样写进去会让下次读出来
  // 是个 null，而 null 和缺省的行为不一样。空的就当没填，键去掉。
  raw.station = Object.fromEntries(
    Object.entries(next.station).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  );
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
  //
  // 重新读一遍文件，而不是逐个字段往回抄。逐个抄的话漏一个就长期不一致：
  // analog 就漏过，结果文件和电台都换了频率，而设置页还显示旧的那个，
  // 看起来像「改了没生效」。重读一遍，漏不掉。
  const fresh = loadConfig(config.path);
  if (!fresh.ok) {
    // 刚写出去的东西自己读不回来，说明写坏了，这时候该吵。
    throw new Error(`写完的配置读不回来：${fresh.problems.join('，')}`);
  }
  config.station = fresh.config.station;
  config.channels = fresh.config.channels;
  config.queries = fresh.config.queries;
  config.analog = fresh.config.analog;
}
