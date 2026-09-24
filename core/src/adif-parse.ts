import { bandOf } from './band.ts';
import { normalizeCallsign } from './callsign.ts';
import type { Mode, QsoDraft } from './types.ts';

/**
 * 读 ADIF。
 *
 * 只认这套系统用得上的字段，别的原样跳过。这是为了把别处记的日志搬进来，
 * 不是要做一个通用的 ADIF 处理器。
 *
 * 长度按 UTF-8 字节数算，和写出去时一致。有些程序写的长度是错的，所以按长度
 * 切出来的值后面必须紧跟空白和下一个标记，不然就退回到「到下一个标记为止」。
 */

export interface AdifRecord {
  fields: Map<string, string>;
  /** 这条记录在文件里的序号，从 1 开始。报错时指得出是哪一条。 */
  index: number;
}

/** 把一份 ADIF 拆成一条条记录。头部（到 <EOH> 为止）跳过。 */
export function adifRecords(text: string): AdifRecord[] {
  const out: AdifRecord[] = [];
  let fields = new Map<string, string>();
  let index = 0;

  for (const tag of tags(text, headerEnd(text))) {
    if (tag.name === 'EOR') {
      if (fields.size > 0) {
        index += 1;
        out.push({ fields, index });
      }
      fields = new Map();
      continue;
    }
    if (tag.value !== undefined) fields.set(tag.name, tag.value);
  }
  // 最后一条没写 <EOR> 也收下，手工剪出来的文件常常这样。
  if (fields.size > 0) out.push({ fields, index: index + 1 });
  return out;
}

// 用同一个切分器找 <EOH>。直接搜字符串的话，没有头部的文件里某个字段的值
// 恰好写着 <eoh>，前面的字段就全被当成头部丢了。
function headerEnd(text: string): number {
  for (const tag of tags(text, 0)) {
    if (tag.name === 'EOH') return tag.end;
  }
  return 0;
}

interface Tag {
  name: string;
  value?: string;
  /** 这个标记连同它的值在原文里结束的位置。 */
  end: number;
}

// <NAME>、<NAME:len> 或 <NAME:len:TYPE>。名字里不会有空白和尖括号，所以
// 值里的「信号 < 噪声」这种写法不会被当成标记。
const TAG = /<([^\s<>:]+)(?::(\d+)(?::[^\s<>:]*)?)?>/g;

function* tags(text: string, from: number): Generator<Tag> {
  const re = new RegExp(TAG.source, 'g');
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toUpperCase();
    const start = m.index + m[0].length;
    if (m[2] === undefined) {
      yield { name, end: start };
      continue;
    }

    const exact = endAfterBytes(text, start, Number(m[2]));
    const trusted = exact !== undefined && text.slice(exact, nextTag(text, exact)).trim() === '';
    const end = trusted ? exact : nextTag(text, start);
    const raw = text.slice(start, end);
    yield { name, value: trusted ? raw : raw.trim(), end };
    re.lastIndex = end;
  }
}

function nextTag(text: string, from: number): number {
  const re = new RegExp(TAG.source, 'g');
  re.lastIndex = from;
  return re.exec(text)?.index ?? text.length;
}

/**
 * 从 start 起数 n 个 UTF-8 字节，返回结束的位置。切不整齐就返回 undefined。
 * 按码点走，因为 emoji 这类字符在 JS 里是两个码元，却是一个 4 字节的字符。
 */
function endAfterBytes(s: string, start: number, n: number): number | undefined {
  let bytes = 0;
  let i = start;
  while (bytes < n && i < s.length) {
    const cp = s.codePointAt(i)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return bytes === n ? i : undefined;
}

/** ADIF 的 YYYYMMDD + HHMM 或 HHMMSS 一律是 UTC。 */
export function adifUnix(date: string | undefined, time: string | undefined): number | undefined {
  if (date === undefined || !/^\d{8}$/.test(date)) return undefined;
  if (time !== undefined && !/^\d{4}(\d{2})?$/.test(time)) return undefined;
  const t = (time ?? '000000').padEnd(6, '0');
  const parts = [
    date.slice(0, 4),
    date.slice(4, 6),
    date.slice(6, 8),
    t.slice(0, 2),
    t.slice(2, 4),
    t.slice(4, 6),
  ].map(Number);
  const [y, mo, d, h, mi, s] = parts;
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC 不拒绝 25 点或 13 月，它会顺延到下一天、下一年。读回来对不上
  // 就说明原来那个日期不存在。
  const back = [
    at.getUTCFullYear(),
    at.getUTCMonth() + 1,
    at.getUTCDate(),
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
  ];
  return back.every((v, i) => v === parts[i]) ? Math.floor(at.getTime() / 1000) : undefined;
}

/** ADIF 的模式回到我们这两个取值。别的模式这套系统产生不了，也存不下。 */
export function modeFromAdif(mode?: string, submode?: string): Mode | undefined {
  const m = (mode ?? '').toUpperCase();
  const sub = (submode ?? '').toUpperCase();
  if (m === 'FM') return 'FM';
  if (sub === 'DMR') return 'DMR';
  if (m === 'DMR') return 'DMR';
  return undefined;
}

export interface ParsedAdif {
  /** 读出来能用的那些。 */
  drafts: QsoDraft[];
  /** 读不了的那些，每条一句话，带记录序号。 */
  problems: string[];
}

const num = (v?: string) => {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function parseAdif(text: string): ParsedAdif {
  const drafts: QsoDraft[] = [];
  const problems: string[] = [];

  for (const rec of adifRecords(text)) {
    const f = rec.fields;
    const call = normalizeCallsign(f.get('CALL') ?? '');
    const startAt = adifUnix(f.get('QSO_DATE'), f.get('TIME_ON'));
    const mode = modeFromAdif(f.get('MODE'), f.get('SUBMODE'));
    const freqMhz = num(f.get('FREQ'));
    const band = freqMhz === undefined ? f.get('BAND') : bandOf(freqMhz);

    // 频率写了但不在本台的波段里，要说清楚是超范围，不是「没写」。
    // 这套系统只记 2m 和 70cm，别的波段存不下也不该假装存下了。
    if (freqMhz !== undefined && bandOf(freqMhz) === undefined) {
      problems.push(`第 ${rec.index} 条的 ${freqMhz} MHz 不在 2m 或 70cm 段内，跳过`);
      continue;
    }

    const date = f.get('QSO_DATE');
    if (startAt === undefined && date !== undefined) {
      const time = f.get('TIME_ON');
      problems.push(
        `第 ${rec.index} 条的日期或时间不存在（QSO_DATE ${date}${time === undefined ? '' : `，TIME_ON ${time}`}），跳过`,
      );
      continue;
    }

    const missing: string[] = [];
    if (!call) missing.push('CALL');
    if (startAt === undefined) missing.push('QSO_DATE');
    if (mode === undefined) missing.push('MODE');
    if (band === undefined || band === '') missing.push('BAND 或 FREQ');
    if (missing.length > 0) {
      problems.push(`第 ${rec.index} 条缺 ${missing.join('、')}，跳过`);
      continue;
    }

    drafts.push({
      call,
      startAt,
      mode,
      freqMhz,
      band,
      rstSent: f.get('RST_SENT') ?? '59',
      rstRcvd: f.get('RST_RCVD') ?? '59',
      gridsquare: f.get('GRIDSQUARE'),
      qth: f.get('QTH'),
      myGridsquare: f.get('MY_GRIDSQUARE'),
      myQth: f.get('MY_CITY'),
      myDevice: f.get('MY_RIG'),
      myAntenna: f.get('MY_ANTENNA'),
      myPower: f.get('TX_PWR') === undefined ? undefined : `${f.get('TX_PWR')}W`,
      myHeightM: num(f.get('MY_ALTITUDE')),
      note: f.get('COMMENT') ?? f.get('NOTES'),
    });
  }

  return { drafts, problems };
}
