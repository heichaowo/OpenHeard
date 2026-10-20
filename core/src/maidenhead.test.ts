import { describe, expect, it } from 'vitest';
import { gridBounds, gridCenter, isValidGrid, toGrid } from './maidenhead.ts';

describe('toGrid', () => {
  it('四个城市的 6 位和 8 位网格', () => {
    expect(toGrid(39.9042, 116.4074, 6)).toBe('OM89EV');
    expect(toGrid(39.9042, 116.4074, 8)).toBe('OM89EV87');
    expect(toGrid(31.2304, 121.4737, 6)).toBe('PM01RF');
    expect(toGrid(31.2304, 121.4737, 8)).toBe('PM01RF65');
    expect(toGrid(35.6762, 139.6503, 6)).toBe('PM95TQ');
    expect(toGrid(35.6762, 139.6503, 8)).toBe('PM95TQ82');
    expect(toGrid(45.58, 84.89, 6)).toBe('NN25KN');
    expect(toGrid(45.58, 84.89, 8)).toBe('NN25KN69');
  });

  it('缺省 6 位', () => {
    expect(toGrid(39.9042, 116.4074)).toBe('OM89EV');
  });

  it('纬度 90 和经度 180 落进最后一格，南极西端落进第一格', () => {
    expect(toGrid(90, 180, 6)).toBe('RR99XX');
    expect(toGrid(-90, -180, 6)).toBe('AA00AA');
  });

  it('格边正好落在整数上：西南角算这一格，往西差一点就是前一格', () => {
    const b = gridBounds('OM89EV');
    expect(toGrid(b.south, b.west, 6)).toBe('OM89EV');
    expect(toGrid(b.south, b.west - 1e-9, 6)).toBe('OM89DV');
  });

  it('坐标越界或不是数就抛错', () => {
    expect(() => toGrid(91, 0)).toThrow(RangeError);
    expect(() => toGrid(0, 181)).toThrow(RangeError);
    expect(() => toGrid(NaN, 0)).toThrow(RangeError);
  });
});

describe('isValidGrid', () => {
  it('4、6、8 位，大小写都认', () => {
    expect(isValidGrid('OM89')).toBe(true);
    expect(isValidGrid('om89ev')).toBe(true);
    expect(isValidGrid('OM89EV87')).toBe(true);
  });

  it('位数不对、字母超出范围、7 位、2 位都不认', () => {
    expect(isValidGrid('')).toBe(false);
    expect(isValidGrid('OM')).toBe(false);
    expect(isValidGrid('OM8')).toBe(false);
    expect(isValidGrid('OM89E')).toBe(false);
    expect(isValidGrid('OM89EV8')).toBe(false);
    expect(isValidGrid('SM89EV')).toBe(false);
    expect(isValidGrid('OM89EY')).toBe(false);
    expect(isValidGrid('OM89EV87X')).toBe(false);
  });
});

describe('gridBounds 和 gridCenter', () => {
  it('各档的格子大小：4 位 2°×1°，6 位 5′×2.5′，8 位 30″×15″', () => {
    const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);
    const g4 = gridBounds('OM89');
    near(g4.east - g4.west, 2);
    near(g4.north - g4.south, 1);
    const g6 = gridBounds('OM89EV');
    near(g6.east - g6.west, 1 / 12);
    near(g6.north - g6.south, 1 / 24);
    const g8 = gridBounds('OM89EV87');
    near(g8.east - g8.west, 1 / 120);
    near(g8.north - g8.south, 1 / 240);
  });

  it('OM89EV 的四条边', () => {
    const b = gridBounds('OM89EV');
    expect(b.west).toBeCloseTo(116.3333333, 6);
    expect(b.east).toBeCloseTo(116.4166667, 6);
    expect(b.south).toBeCloseTo(39.8750000, 6);
    expect(b.north).toBeCloseTo(39.9166667, 6);
  });

  it('中心点回算还是同一格，各档都是', () => {
    for (const g of ['OM89', 'OM89EV', 'OM89EV87', 'PM01RF', 'NN25KN69', 'RR99XX', 'AA00AA']) {
      const c = gridCenter(g);
      expect(toGrid(c.lat, c.lon, g.length === 8 ? 8 : 6).startsWith(g.slice(0, 6))).toBe(true);
      if (g.length === 8) expect(toGrid(c.lat, c.lon, 8)).toBe(g);
    }
  });

  it('小写输入和大写一样', () => {
    expect(gridBounds('om89ev')).toEqual(gridBounds('OM89EV'));
  });

  it('不是网格就抛错', () => {
    expect(() => gridBounds('ZZ99')).toThrow(RangeError);
    expect(() => gridCenter('OM8')).toThrow(RangeError);
  });
});
