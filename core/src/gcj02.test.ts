import { describe, expect, it } from 'vitest';
import { gcj02ToWgs84, outOfChina, wgs84ToGcj02 } from './gcj02.ts';
import { toGrid } from './maidenhead.ts';

/** 两点相距多少米，球面近似够用。 */
function meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const p = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * p) / 2) ** 2 +
    Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(((b.lon - a.lon) * p) / 2) ** 2;
  return 2 * 6378137 * Math.asin(Math.sqrt(h));
}

describe('wgs84ToGcj02', () => {
  // 偏移量取自 eviltransform 的实测：北京 556 m，克拉玛依 208 m。
  it('国内的点偏移几百米，量级和已知值吻合', () => {
    const bj = { lat: 39.9042, lon: 116.4074 };
    const kl = { lat: 45.58, lon: 84.89 };
    expect(meters(bj, wgs84ToGcj02(bj.lat, bj.lon))).toBeGreaterThan(500);
    expect(meters(bj, wgs84ToGcj02(bj.lat, bj.lon))).toBeLessThan(600);
    expect(meters(kl, wgs84ToGcj02(kl.lat, kl.lon))).toBeGreaterThan(180);
    expect(meters(kl, wgs84ToGcj02(kl.lat, kl.lon))).toBeLessThan(240);
  });

  it('偏移方向是东北：北京的 GCJ 经纬度都比 WGS 大', () => {
    const g = wgs84ToGcj02(39.9042, 116.4074);
    expect(g.lat).toBeGreaterThan(39.9042);
    expect(g.lon).toBeGreaterThan(116.4074);
  });

  it('框外原样返回：东京、悉尼', () => {
    expect(wgs84ToGcj02(35.6762, 139.6503)).toEqual({ lat: 35.6762, lon: 139.6503 });
    expect(wgs84ToGcj02(-33.87, 151.21)).toEqual({ lat: -33.87, lon: 151.21 });
  });
});

describe('outOfChina', () => {
  it('框的四边：里面算国内，外面不算', () => {
    expect(outOfChina(39.9, 116.4)).toBe(false);
    expect(outOfChina(35.68, 139.69)).toBe(true);
    expect(outOfChina(60, 100)).toBe(true);
    expect(outOfChina(0.5, 100)).toBe(true);
    expect(outOfChina(30, 70)).toBe(true);
  });
});

describe('gcj02ToWgs84', () => {
  it('来回一趟误差在微米级，整片国土取样', () => {
    let worst = 0;
    for (let lat = 20; lat <= 52; lat += 2.5) {
      for (let lon = 75; lon <= 133; lon += 3.5) {
        const g = wgs84ToGcj02(lat, lon);
        worst = Math.max(worst, meters({ lat, lon }, gcj02ToWgs84(g.lat, g.lon)));
      }
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('框外原样返回', () => {
    expect(gcj02ToWgs84(35.6762, 139.6503)).toEqual({ lat: 35.6762, lon: 139.6503 });
  });

  it('高德点出来的点换回 WGS-84 再算 8 位网格，和原来的点一致', () => {
    const wgs = { lat: 39.9042, lon: 116.4074 };
    const g = wgs84ToGcj02(wgs.lat, wgs.lon);
    const back = gcj02ToWgs84(g.lat, g.lon);
    expect(toGrid(back.lat, back.lon, 8)).toBe('OM89EV87');
  });

  it('不换回来直接算会错：北京这个点 8 位网格不同', () => {
    const g = wgs84ToGcj02(39.9042, 116.4074);
    expect(toGrid(g.lat, g.lon, 8)).not.toBe('OM89EV87');
  });
});
