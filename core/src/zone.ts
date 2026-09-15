/**
 * 时区名。
 *
 * 浏览器的 Intl.supportedValuesOf('timeZone') 给的是它自己那份 IANA 列表，
 * 里面有一批仍然是旧名：加尔各答报成 Asia/Calcutta，基辅报成 Europe/Kiev。
 * 照原样显示，人按现在的城市名去找就找不到。
 *
 * 值仍然用浏览器给的那个 ID，只有显示和搜索按现名。
 */
export const ZONE_RENAMES: Record<string, string> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

/** 拿来显示的名字，旧名换成现名。 */
export function zoneName(zone: string): string {
  return ZONE_RENAMES[zone] ?? zone;
}

/**
 * 搜索时拿来比对的那串字：现名、旧名，以及去掉区域前缀之后的城市名。
 *
 * 下划线换成空格，这样打 "new york" 和 "New_York" 都找得到。
 */
export function zoneSearchText(zone: string): string {
  const names = new Set([zone, zoneName(zone)]);
  for (const n of [...names]) {
    const city = n.slice(n.lastIndexOf('/') + 1);
    names.add(city);
    names.add(city.replaceAll('_', ' '));
  }
  return [...names].join(' ').toLowerCase();
}

export function zoneMatches(zone: string, query: string): boolean {
  const q = query.trim().toLowerCase().replaceAll('_', ' ');
  return q === '' || zoneSearchText(zone).includes(q);
}
