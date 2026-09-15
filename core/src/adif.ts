import type { Mode, Qso } from './types.ts';

// ADIF 组装。时间一律 UTC，长度是 UTF-8 字节数。

const ADIF_VER = '3.1.5';

const pad = (n: number) => String(n).padStart(2, '0');

export function adifDate(unix: number): string {
  const d = new Date(unix * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

export function adifTime(unix: number): string {
  const d = new Date(unix * 1000);
  return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** ADIF 没有 MODE=DMR 这个取值。 */
export function adifMode(mode: Mode): { mode: string; submode?: string } {
  return mode === 'DMR' ? { mode: 'DIGITALVOICE', submode: 'DMR' } : { mode: 'FM' };
}

/** TX_PWR 要的是瓦特数，而我们存的是「5W」这样的口播形式。 */
function watts(power?: string): number | undefined {
  if (!power) return undefined;
  const m = /\d+(\.\d+)?/.exec(power);
  if (!m) return undefined;
  // TX_PWR 要正数。0 W 不是功率，宁可不写这个字段。
  const w = Number(m[0]);
  return w > 0 ? w : undefined;
}

function field(name: string, value: string | number | undefined): string {
  if (value === undefined || value === '') return '';
  const v = String(value);
  return `<${name}:${new TextEncoder().encode(v).length}>${v} `;
}

export function adifRecord(qso: Qso): string {
  const { mode, submode } = adifMode(qso.mode);
  return [
    field('CALL', qso.call),
    field('QSO_DATE', adifDate(qso.startAt)),
    field('TIME_ON', adifTime(qso.startAt)),
    field('BAND', qso.band),
    field('MODE', mode),
    field('SUBMODE', submode),
    field('FREQ', qso.freqMhz),
    field('RST_SENT', qso.rstSent),
    field('RST_RCVD', qso.rstRcvd),
    field('GRIDSQUARE', qso.gridsquare),
    field('QTH', qso.qth),
    field('MY_GRIDSQUARE', qso.myGridsquare),
    field('MY_CITY', qso.myQth),
    field('MY_RIG', qso.myDevice),
    field('MY_ANTENNA', qso.myAntenna),
    field('TX_PWR', watts(qso.myPower)),
    field('MY_ALTITUDE', qso.myHeightM),
    field('COMMENT', qso.note),
    '<EOR>',
  ].join('');
}

export function adifFile(qsos: Qso[]): string {
  const header = [
    'OpenHeard ADIF export',
    field('ADIF_VER', ADIF_VER) + field('PROGRAMID', 'OpenHeard') + '<EOH>',
  ].join('\n');
  return [header, ...qsos.map(adifRecord), ''].join('\n');
}
