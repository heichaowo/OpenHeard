import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { aiDefaults, checkQueries, mapDefaults, readAnalogChannels, resolveAiConfig, resolveMapConfig } from './core.ts';
import type { AiConfig, Channel, MapConfig, StationDefaults } from './core.ts';
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
  /** BrandMeister 查询的开关，缺省开。 */
  brandmeisterEnabled?: boolean;
  analog?: AnalogSettings;
  ai?: AiSettings;
  map?: MapSettings;
}

/**
 * ai 段，读出来的样子：密钥换成 apiKeySet，只写不读。
 * 提交时 apiKey 才出现（缺省或 null 保留已存的，'' 清掉），*Set 一律忽略。
 */
export interface AiSettings {
  enabled: boolean;
  vad: AiConfig['vad'];
  asr: Omit<AiConfig['asr'], 'apiKey'> & { apiKeySet: boolean };
  text: Omit<AiConfig['text'], 'apiKey'> & { apiKeySet: boolean };
}

/** 高德的 key 是公开的（页面要拿它加载地图），安全密钥只写不读。 */
export interface MapSettings {
  provider: MapConfig['provider'];
  amapKey: string;
  amapSecurityCodeSet: boolean;
}

export interface AnalogSettings {
  /** 同一支接收机守的几个信道。最高和最低相差不超过 1.8 MHz，见 core 的 planTuning。 */
  channels: { freqMhz: number; channel: string }[];
  /** 模拟守听的开关，缺省开。 */
  enabled?: boolean;
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

/**
 * 表单里清空一格，antd 给的是 null，文本框给的是空串。两样都当「没填」，
 * 回到缺省值。
 */
const given = (v: unknown) =>
  v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

/**
 * 没配过模拟守听时，表单照样会交一个各项都空的 analog 上来。它不是要开始配，
 * 当成没交。否则保存本台信息也会被「频率必填」拦下。
 *
 * 不看 enabled：只切开关、别的都没给，也算「没交」，不然关掉模拟守听会被
 * 拦下要求至少一个信道——那正是这条判断本来要防的坑，只是现在多了一个
 * 「关」也要放过的理由。
 */
const blankAnalog = (a: unknown) =>
  isObject(a) && !Object.entries(a).some(([k, v]) => k !== 'enabled' && given(v));

const pickMargin = (submitted: unknown, existing: number | undefined, fallback: number) => {
  if (typeof submitted === 'number') return submitted;
  // 清空了就是要回到缺省值，不是保留文件里原来那个。
  if (submitted === null || submitted === '') return fallback;
  return existing ?? fallback;
};

/**
 * @param current 现在生效的那份配置。只提交一个余量时，要拿它和文件里原来
 *   那个凑起来一起验，否则凑出来的组合从来没被验过；BrandMeister 关着时
 *   queries 是否必填也看它。
 */
export function checkSettings(
  raw: unknown,
  current?: Partial<Pick<Config, 'analog' | 'brandmeisterEnabled' | 'ai' | 'map'>>,
): string[] {
  if (!isObject(raw)) return ['设置的顶层不是对象'];
  const problems: string[] = [];
  const brandmeisterEnabled = raw.brandmeisterEnabled !== false;

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
    // 只在 BrandMeister 开着、queries 真的非空时才要求它。关着时 queries
    // 可以是空的，这条规则也就不适用。
    if (
      brandmeisterEnabled &&
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

  // BrandMeister 关着时，queries 可以缺失或者是空数组；传了的条目还是照样验。
  problems.push(...checkQueries(raw.queries, brandmeisterEnabled));

  if (raw.analog !== undefined && raw.analog !== null && !blankAnalog(raw.analog)) {
    const a = raw.analog;
    if (!isObject(a)) {
      problems.push('analog 不是对象');
    } else {
      const analogEnabled = a.enabled !== false;
      // 和守护进程、api 读配置是同一个函数。设置页收下的，守护进程一定起得来。
      // 模拟守听关着时只验提交里有的那几项，不强求至少一个信道。
      problems.push(...readAnalogChannels({ channels: a.channels ?? [] }, analogEnabled).problems);
      if (given(a.gainDb) && typeof a.gainDb !== 'number') problems.push('analog.gainDb 要是数字');
      if (given(a.myUnitId) && !/^[0-9a-fA-F]{1,4}$/.test(String(a.myUnitId))) {
        problems.push('analog.myUnitId 要是 1 到 4 位十六进制，例如 6460');
      }

      for (const k of ['openMarginDb', 'closeMarginDb'] as const) {
        const v = a[k];
        if (given(v) && (typeof v !== 'number' || v <= 0 || v > 60)) {
          problems.push(`analog.${k} 要是 0 到 60 之间的数字`);
        }
      }
      // 回差要按合并之后的值查，不能只看这次提交里带了什么。
      // 只提交一个的话，它会和文件里原来那个凑成一对，而那一对从没验过。
      const open = pickMargin(a.openMarginDb, current?.analog?.openMarginDb, 12);
      const close = pickMargin(a.closeMarginDb, current?.analog?.closeMarginDb, 7);
      if (open - close < 2) {
        problems.push(
          `静噪余量合起来讲不通：打开 ${open}，关闭 ${close}。打开要比关闭至少大 2，中间那段是回差`,
        );
      }
    }
  }

  // 密钥先按已存的解析出来再验：请求体里没有密钥（读出来就只有 apiKeySet），
  // 直接验的话，云端那一步每次保存都会报 apiKey 必填。
  if (raw.ai !== undefined && raw.ai !== null) problems.push(...mergeAi(raw.ai, current?.ai).problems);
  if (raw.map !== undefined && raw.map !== null) problems.push(...mergeMap(raw.map, current?.map).problems);

  return problems;
}

/**
 * 请求里的 ai 段并进已存的那一份，返回合并之后严格校验的结果。
 *
 * 密钥：缺省或 null 保留已存的，'' 清掉，非空文字就是新值。*Set 是读出来给界面看的，
 * 提交里带了也忽略。别的键：缺省或 null 保留已存的。
 */
export function mergeAi(body: unknown, stored: AiConfig | undefined): { config: AiConfig; problems: string[] } {
  if (!isObject(body)) return resolveAiConfig(body);
  const base = stored ?? aiDefaults();
  const merged: Record<string, unknown> = { ...base };
  if (body.enabled !== undefined && body.enabled !== null) merged.enabled = body.enabled;
  for (const sec of ['vad', 'asr', 'text'] as const) {
    const sub = body[sec];
    if (sub === undefined || sub === null) continue;
    // 不是对象的原样放进去，让校验报出来。
    if (!isObject(sub)) {
      merged[sec] = sub;
      continue;
    }
    const out: Record<string, unknown> = { ...base[sec] };
    for (const [k, v] of Object.entries(sub)) {
      if (k.endsWith('Set') || v === undefined || v === null) continue;
      out[k] = v;
    }
    merged[sec] = out;
  }
  return resolveAiConfig(merged);
}

export function mergeMap(body: unknown, stored: MapConfig | undefined): { config: MapConfig; problems: string[] } {
  if (!isObject(body)) return resolveMapConfig(body);
  const merged: Record<string, unknown> = { ...(stored ?? mapDefaults()) };
  for (const [k, v] of Object.entries(body)) {
    if (k.endsWith('Set') || v === undefined || v === null) continue;
    merged[k] = v;
  }
  return resolveMapConfig(merged);
}

/** 从当前配置里挑出可改的那部分，给界面填表用。密钥只报设了没有。 */
export function settingsOf(config: Config, analog?: AnalogSettings): Settings {
  const ai = config.ai ?? aiDefaults();
  const map = config.map ?? mapDefaults();
  const { apiKey: asrKey, ...asr } = ai.asr;
  const { apiKey: textKey, ...text } = ai.text;
  return {
    station: config.station,
    channels: config.channels,
    queries: config.queries,
    brandmeisterEnabled: config.brandmeisterEnabled,
    analog,
    ai: {
      enabled: ai.enabled,
      vad: ai.vad,
      asr: { ...asr, apiKeySet: asrKey !== '' },
      text: { ...text, apiKeySet: textKey !== '' },
    },
    map: {
      provider: map.provider,
      amapKey: map.amapKey,
      amapSecurityCodeSet: map.amapSecurityCode !== '',
    },
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
  // BrandMeister 关着、queries 没给的话保留文件里原来那份，不要拿 undefined
  // 把它从 JSON 里抹掉——那样重新打开时就成了「一条都没配过」。
  if (next.queries !== undefined) raw.queries = next.queries;
  if (typeof next.brandmeisterEnabled === 'boolean') raw.brandmeisterEnabled = next.brandmeisterEnabled;

  if (next.analog !== undefined && next.analog !== null) {
    const before = isObject(raw.analog) ? raw.analog : undefined;
    if (blankAnalog(next.analog)) {
      // 只是切换开关：channels 一律不碰，只改 enabled。文件里压根没有
      // analog 段的话，「没配过模拟守听时表单顺带带上一个空对象」和
      // 「单独把开关切一下」长得一样，分不清哪种，一律当没交，不能凭空
      // 造出一个新的 analog 段。
      if (typeof next.analog.enabled === 'boolean' && before !== undefined) {
        raw.analog = { ...before, enabled: next.analog.enabled };
      }
    } else {
      // recordingsDir 是路径，不在界面上改，保留文件里原来那个。
      const merged: Record<string, unknown> = { ...before, ...next.analog };
      // 清空的那一格去掉键，让缺省值生效。留着原来那个的话，清空等于没改。
      for (const [k, v] of Object.entries(next.analog)) {
        if (!given(v)) delete merged[k];
      }
      // 旧写法的单个频率换成信道表以后就是多余的，留着会让人以为它还管用。
      delete merged.freqMhz;
      delete merged.channel;
      raw.analog = merged;
    }
  }

  // ai 和 map：合并密钥、严格校验之后整段写回。请求体里没有这一段就不动文件里的。
  const touchesAi = next.ai !== undefined && next.ai !== null;
  const touchesMap = next.map !== undefined && next.map !== null;
  if (touchesAi) {
    const merged = mergeAi(next.ai, config.ai);
    if (merged.problems.length > 0) throw new Error(`ai 设置不对，没有落盘：${merged.problems.join('，')}`);
    const { asr, text, ...rest } = merged.config;
    // 密钥空着就不写这个键，文件里不留一个空串。
    const dropEmpty = <T extends { apiKey: string }>({ apiKey, ...r }: T) => (apiKey === '' ? r : { ...r, apiKey });
    raw.ai = { ...rest, asr: dropEmpty(asr), text: dropEmpty(text) };
  }
  if (touchesMap) {
    const merged = mergeMap(next.map, config.map);
    if (merged.problems.length > 0) throw new Error(`map 设置不对，没有落盘：${merged.problems.join('，')}`);
    raw.map = Object.fromEntries(Object.entries(merged.config).filter(([, v]) => v !== ''));
  }

  const tmp = `${config.path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

  // 先在临时文件上确认能读回来，再 rename。反过来的话，写不回来的配置已经
  // 换到了正式路径上，下一次 api 或守护进程起来就直接死在这份坏配置上。
  const fresh = loadConfig(tmp);
  if (!fresh.ok) {
    throw new Error(`写出来的配置读不回来，没有落盘：${fresh.problems.join('，')}`);
  }
  // 文件里原来就有写坏的 ai 或 map，而这次没碰它们，不能因此拦住别的保存。
  const bad = [touchesAi ? fresh.config.aiProblem : undefined, touchesMap ? fresh.config.mapProblem : undefined].filter(
    (p) => p !== undefined,
  );
  if (bad.length > 0) throw new Error(`写出来的配置读不回来，没有落盘：${bad.join('，')}`);
  renameSync(tmp, config.path);

  // 内存里这份是 createStore 按引用拿着的，就地改它，接口立刻反映新值。
  //
  // 重新读一遍文件，而不是逐个字段往回抄。逐个抄的话漏一个就长期不一致：
  // analog 就漏过，结果文件和电台都换了频率，而设置页还显示旧的那个，
  // 看起来像「改了没生效」。重读一遍，漏不掉。
  config.station = fresh.config.station;
  config.channels = fresh.config.channels;
  config.queries = fresh.config.queries;
  config.brandmeisterEnabled = fresh.config.brandmeisterEnabled;
  config.analog = fresh.config.analog;
  config.recordingsDir = fresh.config.recordingsDir;
  config.ai = fresh.config.ai;
  config.aiProblem = fresh.config.aiProblem;
  config.map = fresh.config.map;
  config.mapProblem = fresh.config.mapProblem;
}
