import { bandOf } from './band.ts';
import { normalizeCallsign } from './callsign.ts';
import type { Mode, QsoDraft } from './types.ts';

/**
 * 读 ADIF。
 *
 * 只认这套系统用得上的字段，别的原样跳过。这是为了把别处记的日志搬进来，
 * 不是要做一个通用的 ADIF 处理器。
 *
 * 长度按 UTF-8 字节数算，和写出去时一致。有些程序写的长度是错的，所以
 * 长度只用来定位，真正的边界还是下一个 `<`。
 */

export interface AdifRecord {
  fields: Map<string, string>;
  /** 这条记录在文件里的序号，从 1 开始。报错时指得出是哪一条。 */
  index: number;
}

/** 把一份 ADIF 拆成一条条记录。头部（到 <EOH> 为止）跳过。 */
export function adifRecords(text: string): AdifRecord[] {
  const body = splitHeader(text);
  const out: AdifRecord[] = [];
  let fields = new Map<string, string>();
  let index = 0;

  for (const tag of tags(body)) {
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

function splitHeader(text: string): string {
  const eoh = text.search(/<EOH>/i);
  return eoh < 0 ? text : text.slice(eoh + 5);
}

interface Tag {
  name: string;
  value?: string;
}

function* tags(body: string): Generator<Tag> {
  let i = 0;
  while (i < body.length) {
    const lt = body.indexOf('<', i);
    if (lt < 0) return;
    const gt = body.indexOf('>', lt);
    if (gt < 0) return;

    // <NAME:len> 或 <NAME:len:TYPE> 或 <EOR>
    const [name, len] = body.slice(lt + 1, gt).split(':');
    const upper = (name ?? '').toUpperCase();

    if (len === undefined) {
      yield { name: upper };
      i = gt + 1;
      continue;
    }

    // 长度按字节数给，而 JS 的字符串按码元。先按字节切，切不出来就退回
    // 「到下一个 < 为止」，因为有些程序写的长度是错的。
    const rest = body.slice(gt + 1);
    const want = Number(len);
    const value = Number.isFinite(want) ? takeBytes(rest, want) : undefined;
    const fallback = rest.slice(0, rest.indexOf('<') < 0 ? rest.length : rest.indexOf('<')).trim();
    const picked = value ?? fallback;

    yield { name: upper, value: picked };
    i = gt + 1 + (value === undefined ? fallback.length : charsFor(rest, want));
  }
}

const encoder = new TextEncoder();

/** 取前 n 个 UTF-8 字节对应的那段字符串。切不整齐就返回 undefined。 */
function takeBytes(s: string, n: number): string | undefined {
  if (n === 0) return '';
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    bytes += encoder.encode(s[i]).length;
    if (bytes === n) return s.slice(0, i + 1);
    if (bytes > n) return undefined;
  }
  return undefined;
}

function charsFor(s: string, n: number): number {
  const taken = takeBytes(s, n);
  return taken === undefined ? 0 : taken.length;
}

/** ADIF 的 YYYYMMDD + HHMMSS 一律是 UTC。 */
export function adifUnix(date: string | undefined, time: string | undefined): number | undefined {
  if (date === undefined || !/^\d{8}$/.test(date)) return undefined;
  const t = (time ?? '000000').padEnd(6, '0');
  if (!/^\d{6}$/.test(t)) return undefined;
  const at = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(t.slice(0, 2)),
    Number(t.slice(2, 4)),
    Number(t.slice(4, 6)),
  );
  return Number.isFinite(at) ? Math.floor(at / 1000) : undefined;
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
