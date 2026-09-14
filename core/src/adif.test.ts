import { describe, expect, it } from 'vitest';
import { adifDate, adifFile, adifMode, adifRecord, adifTime } from './adif';
import type { Qso } from './types';

// 2026-09-12T23:30:00Z，在东八区已经是 13 日早上。
const UNIX = Math.floor(Date.UTC(2026, 8, 12, 23, 30, 0) / 1000);

const QSO: Qso = {
  id: 'q1',
  call: 'BD7KLO',
  startAt: UNIX,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'FM',
  rstSent: '59',
  rstRcvd: '57',
  createdAt: UNIX,
};

describe('时间', () => {
  it('用 UTC，不用本地时区', () => {
    expect(adifDate(UNIX)).toBe('20260912');
    expect(adifTime(UNIX)).toBe('233000');
  });

  it('补零', () => {
    const t = Math.floor(Date.UTC(2026, 0, 5, 4, 3, 2) / 1000);
    expect(adifDate(t)).toBe('20260105');
    expect(adifTime(t)).toBe('040302');
  });
});

describe('模式', () => {
  it('DMR 是 DIGITALVOICE 的子模式', () => {
    expect(adifMode('DMR')).toEqual({ mode: 'DIGITALVOICE', submode: 'DMR' });
  });

  it('FM 没有子模式', () => {
    expect(adifMode('FM')).toEqual({ mode: 'FM' });
  });
});

describe('记录', () => {
  it('必填字段都在，可选字段缺了就不出现', () => {
    const r = adifRecord(QSO);
    expect(r).toContain('<CALL:6>BD7KLO ');
    expect(r).toContain('<QSO_DATE:8>20260912 ');
    expect(r).toContain('<TIME_ON:6>233000 ');
    expect(r).toContain('<BAND:4>70cm ');
    expect(r).toContain('<MODE:2>FM ');
    expect(r).toContain('<FREQ:7>439.525 ');
    expect(r).toContain('<RST_SENT:2>59 ');
    expect(r).toContain('<RST_RCVD:2>57 ');
    expect(r.endsWith('<EOR>')).toBe(true);
    expect(r).not.toContain('SUBMODE');
    expect(r).not.toContain('GRIDSQUARE');
    expect(r).not.toContain('TX_PWR');
  });

  it('长度是 UTF-8 字节数，不是字符数', () => {
    const r = adifRecord({ ...QSO, myQth: '成都' });
    expect(r).toContain('<MY_CITY:6>成都 ');
  });

  it('TX_PWR 从口播形式里取瓦特数', () => {
    expect(adifRecord({ ...QSO, myPower: '5W' })).toContain('<TX_PWR:1>5 ');
    expect(adifRecord({ ...QSO, myPower: '0.5W' })).toContain('<TX_PWR:3>0.5 ');
    expect(adifRecord({ ...QSO, myPower: '不知道' })).not.toContain('TX_PWR');
  });

  it('DMR 同时写 MODE 和 SUBMODE', () => {
    const r = adifRecord({ ...QSO, mode: 'DMR' });
    expect(r).toContain('<MODE:12>DIGITALVOICE ');
    expect(r).toContain('<SUBMODE:3>DMR ');
  });
});

describe('文件', () => {
  it('头不以尖括号开头，且有 EOH', () => {
    const f = adifFile([QSO]);
    expect(f.startsWith('<')).toBe(false);
    expect(f).toContain('<ADIF_VER:5>3.1.5 ');
    expect(f).toContain('<EOH>');
    expect(f.match(/<EOR>/g)).toHaveLength(1);
  });

  it('空日志也能导出', () => {
    expect(adifFile([])).toContain('<EOH>');
    expect(adifFile([])).not.toContain('<EOR>');
  });
});
