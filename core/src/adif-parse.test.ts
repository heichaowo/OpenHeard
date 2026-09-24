import { describe, expect, it } from 'vitest';
import { adifFile } from './adif.ts';
import { adifRecords, adifUnix, modeFromAdif, parseAdif } from './adif-parse.ts';
import type { Qso } from './types.ts';

const qso = (over: Partial<Qso> = {}): Qso => ({
  id: 'q1',
  call: 'BD7KLO',
  startAt: 1_789_465_773,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'FM',
  rstSent: '59',
  rstRcvd: '59',
  createdAt: 1_789_465_800,
  ...over,
});

describe('adifRecords', () => {
  it('跳过头部，按 EOR 分条', () => {
    const recs = adifRecords('随便写的头 <ADIF_VER:5>3.1.5 <EOH>\n<CALL:6>BD7KLO <EOR>\n<CALL:5>BA1AA <EOR>');
    expect(recs.length).toBe(2);
    expect(recs[0].fields.get('CALL')).toBe('BD7KLO');
    expect(recs[1].fields.get('CALL')).toBe('BA1AA');
  });

  it('没有头部也能读', () => {
    expect(adifRecords('<CALL:6>BD7KLO <EOR>').length).toBe(1);
  });

  // 手工剪出来的文件常常最后一条忘了写 EOR。
  it('最后一条没写 EOR 也收下', () => {
    const recs = adifRecords('<EOH><CALL:6>BD7KLO <EOR><CALL:5>BA1AA ');
    expect(recs.length).toBe(2);
  });

  it('字段名大小写不敏感', () => {
    expect(adifRecords('<EOH><call:6>BD7KLO <eor>')[0].fields.get('CALL')).toBe('BD7KLO');
  });

  // 长度是 UTF-8 字节数，不是字符数。
  it('中文字段按字节长度切', () => {
    const recs = adifRecords('<EOH><QTH:6>成都 <CALL:5>BA1AA <EOR>');
    expect(recs[0].fields.get('QTH')).toBe('成都');
    expect(recs[0].fields.get('CALL')).toBe('BA1AA');
  });

  // 有些程序写的长度是错的，不能因此把整条丢掉。
  it('长度写错时退回到下一个尖括号为止', () => {
    const recs = adifRecords('<EOH><CALL:99>BD7KLO <MODE:2>FM <EOR>');
    expect(recs[0].fields.get('CALL')).toBe('BD7KLO');
  });

  it('带类型的长度也认', () => {
    expect(adifRecords('<EOH><FREQ:7:N>439.525 <EOR>')[0].fields.get('FREQ')).toBe('439.525');
  });

  // emoji 在 JS 里是两个码元，按码元数字节会把它算成 6 个字节。
  it('四字节字符也按字节长度切', () => {
    const recs = adifRecords('<EOH><COMMENT:6>😀ab<CALL:5>BA1AA<EOR>');
    expect(recs[0].fields.get('COMMENT')).toBe('😀ab');
    expect(recs[0].fields.get('CALL')).toBe('BA1AA');
  });

  // 长度多写一个字节、后面又紧贴着下一个标记，按长度切会吃掉下一个标记的 <。
  it('长度多写了也不吞掉紧跟着的下一个字段', () => {
    const recs = adifRecords('<EOH><CALL:6>BA1AA<QSO_DATE:8>20260915<EOR>');
    expect(recs[0].fields.get('CALL')).toBe('BA1AA');
    expect(recs[0].fields.get('QSO_DATE')).toBe('20260915');
  });

  it('值里有 < 时，长度对就照长度切', () => {
    const recs = adifRecords('<EOH><COMMENT:19>signal < noise here<CALL:5>BA1AA<EOR>');
    expect(recs[0].fields.get('COMMENT')).toBe('signal < noise here');
    expect(recs[0].fields.get('CALL')).toBe('BA1AA');
  });

  it('值里有 < 时，长度错了也不把后面的字段搅乱', () => {
    const recs = adifRecords('<EOH><COMMENT:9>signal < noise here<CALL:5>BA1AA<EOR>');
    expect(recs[0].fields.get('COMMENT')).toBe('signal < noise here');
    expect(recs[0].fields.get('CALL')).toBe('BA1AA');
  });

  it('没有头部时，值里写着 <eoh> 不当成头部结束', () => {
    const recs = adifRecords('<CALL:5>BA1AA <COMMENT:13>ends at <eoh> <EOR>');
    expect(recs.length).toBe(1);
    expect(recs[0].fields.get('CALL')).toBe('BA1AA');
    expect(recs[0].fields.get('COMMENT')).toBe('ends at <eoh>');
  });

  it('带 BOM 和 CRLF 的文件照样读', () => {
    const recs = adifRecords('\uFEFFheader\r\n<eoh>\r\n<CALL:5>BA1AA\r\n<EOR>\r\n');
    expect(recs[0].fields.get('CALL')).toBe('BA1AA');
  });
});

describe('adifUnix', () => {
  it('按 UTC 读，不看本机时区', () => {
    expect(adifUnix('20260915', '094933')).toBe(1_789_465_773);
  });

  it('没有时间就当当天零点', () => {
    expect(adifUnix('20260915', undefined)).toBe(adifUnix('20260915', '000000'));
  });

  it('日期不成样子就没有', () => {
    expect(adifUnix('2026-09-15', '094933')).toBeUndefined();
    expect(adifUnix(undefined, '094933')).toBeUndefined();
  });

  it('只写到分钟的时间也认', () => {
    expect(adifUnix('20260915', '0949')).toBe(adifUnix('20260915', '094900'));
  });

  // Date.UTC 会把 25 点顺延成第二天，读出来是一个错的时刻。
  it('不存在的日期和时刻就没有，不顺延', () => {
    expect(adifUnix('20260101', '259999')).toBeUndefined();
    expect(adifUnix('20261301', '000000')).toBeUndefined();
    expect(adifUnix('20260230', '000000')).toBeUndefined();
    expect(adifUnix('20260915', '12')).toBeUndefined();
  });
});

describe('modeFromAdif', () => {
  it('DIGITALVOICE 加 SUBMODE=DMR 就是 DMR', () => {
    expect(modeFromAdif('DIGITALVOICE', 'DMR')).toBe('DMR');
    expect(modeFromAdif('FM')).toBe('FM');
    expect(modeFromAdif('fm')).toBe('FM');
  });

  it('这套系统产生不了的模式就是没有', () => {
    expect(modeFromAdif('SSB')).toBeUndefined();
    expect(modeFromAdif('FT8')).toBeUndefined();
    expect(modeFromAdif(undefined)).toBeUndefined();
  });
});

describe('parseAdif', () => {
  // 自己写出去的自己一定读得回来，这是最起码的。
  it('读得回自己导出的文件', () => {
    const before = [
      qso({ qth: '深圳', gridsquare: 'OL72', note: '中继信号很好', myQth: '成都', myPower: '5W' }),
      qso({ id: 'q2', call: 'BA1AA', mode: 'DMR', startAt: 1_789_000_000 }),
    ];

    const { drafts, problems } = parseAdif(adifFile(before));

    expect(problems).toEqual([]);
    expect(drafts.length).toBe(2);
    expect(drafts[0]).toMatchObject({
      call: 'BD7KLO',
      startAt: before[0].startAt,
      freqMhz: 439.525,
      band: '70cm',
      mode: 'FM',
      qth: '深圳',
      gridsquare: 'OL72',
      note: '中继信号很好',
      myQth: '成都',
      myPower: '5W',
    });
    expect(drafts[1]).toMatchObject({ call: 'BA1AA', mode: 'DMR' });
  });

  it('呼号照样去空格转大写', () => {
    expect(parseAdif('<EOH><CALL:8> bd7klo <QSO_DATE:8>20260915 <MODE:2>FM <FREQ:7>439.525 <EOR>')
      .drafts[0].call).toBe('BD7KLO');
  });

  it('缺必填的那条跳过，并说清楚缺什么', () => {
    const { drafts, problems } = parseAdif(
      '<EOH><CALL:6>BD7KLO <EOR><CALL:5>BA1AA <QSO_DATE:8>20260915 <MODE:2>FM <FREQ:7>439.525 <EOR>',
    );
    expect(drafts.length).toBe(1);
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/第 1 条/);
  });

  // 这套系统只记 2m 和 70cm，别的波段存不下也不该假装存下了。
  it('不在本台波段里的跳过', () => {
    const { drafts, problems } = parseAdif(
      '<EOH><CALL:5>BA1AA <QSO_DATE:8>20260915 <MODE:2>FM <FREQ:5>14.20 <EOR>',
    );
    expect(drafts.length).toBe(0);
    expect(problems[0]).toMatch(/不在 2m 或 70cm/);
  });

  it('没有 FREQ 时用 BAND', () => {
    const { drafts } = parseAdif(
      '<EOH><CALL:5>BA1AA <QSO_DATE:8>20260915 <MODE:2>FM <BAND:4>70cm <EOR>',
    );
    expect(drafts[0].band).toBe('70cm');
    expect(drafts[0].freqMhz).toBeUndefined();
  });

  it('日期不存在的那条跳过，并说是日期不对', () => {
    const { drafts, problems } = parseAdif(
      '<EOH><CALL:5>BA1AA <QSO_DATE:8>20261301 <TIME_ON:4>1200 <MODE:2>FM <FREQ:7>439.525 <EOR>',
    );
    expect(drafts.length).toBe(0);
    expect(problems[0]).toMatch(/日期或时间不存在.*20261301/);
  });

  it('没写报告时给 59', () => {
    const { drafts } = parseAdif(
      '<EOH><CALL:5>BA1AA <QSO_DATE:8>20260915 <MODE:2>FM <FREQ:7>439.525 <EOR>',
    );
    expect([drafts[0].rstSent, drafts[0].rstRcvd]).toEqual(['59', '59']);
  });

  it('空文件不是错，只是没有记录', () => {
    expect(parseAdif('')).toEqual({ drafts: [], problems: [] });
    expect(parseAdif('只有头部 <EOH>\n')).toEqual({ drafts: [], problems: [] });
  });
});
