/**
 * WGS-84 和 GCJ-02（高德的坐标系）互转。
 * 公式出自 eviltransform（googollee，BSD 许可）。高德的地图、地名搜索和地理编码
 * 都在 GCJ-02 里，日志里的网格按 WGS-84 算，所以进出高德的每个点都要过这里。
 */

const EE = 0.00669342162296594323;
const EARTH_R = 6378137;

/** 中国大致的外框。框外不偏移，框里的港澳台和邻国也会被偏移，和多数实现一致。 */
export function outOfChina(lat: number, lon: number): boolean {
  return !(lon >= 72.004 && lon <= 137.8347 && lat >= 0.8293 && lat <= 55.8271);
}

function transform(x: number, y: number): [number, number] {
  const d = 20 * Math.sin(6 * Math.PI * x) + 20 * Math.sin(2 * Math.PI * x);
  let lat =
    d +
    20 * Math.sin(Math.PI * y) +
    40 * Math.sin((Math.PI * y) / 3) +
    160 * Math.sin((Math.PI * y) / 12) +
    320 * Math.sin((Math.PI * y) / 30);
  let lon =
    d +
    20 * Math.sin(Math.PI * x) +
    40 * Math.sin((Math.PI * x) / 3) +
    150 * Math.sin((Math.PI * x) / 12) +
    300 * Math.sin((Math.PI * x) / 30);
  lat *= 2 / 3;
  lon *= 2 / 3;
  lat += -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  lon += 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  return [lat, lon];
}

/** WGS-84 到 GCJ-02。框外原样返回。 */
export function wgs84ToGcj02(lat: number, lon: number): { lat: number; lon: number } {
  if (outOfChina(lat, lon)) return { lat, lon };
  let [dLat, dLon] = transform(lon - 105, lat - 35);
  const rad = (lat * Math.PI) / 180;
  const m = 1 - EE * Math.sin(rad) ** 2;
  const sq = Math.sqrt(m);
  dLat = (dLat * 180) / (((EARTH_R * (1 - EE)) / (m * sq)) * Math.PI);
  dLon = (dLon * 180) / ((EARTH_R / sq) * Math.cos(rad) * Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

/**
 * GCJ-02 回到 WGS-84。正向变换没有闭式逆，用定点迭代：每次把还差的偏移
 * 减回去。实测 5 步收敛到微米级，一步到位的近似法最大差 4 米，够不到 8 位网格。
 */
export function gcj02ToWgs84(lat: number, lon: number): { lat: number; lon: number } {
  if (outOfChina(lat, lon)) return { lat, lon };
  let w = { lat, lon };
  for (let i = 0; i < 5; i++) {
    const g = wgs84ToGcj02(w.lat, w.lon);
    w = { lat: w.lat - (g.lat - lat), lon: w.lon - (g.lon - lon) };
  }
  return w;
}
