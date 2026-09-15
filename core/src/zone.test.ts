import { describe, expect, it } from 'vitest';
import { zoneMatches, zoneName, zoneSearchText } from './zone.ts';

describe('zoneName', () => {
  // 浏览器报 Asia/Calcutta，而现在这座城市叫 Kolkata。照原样显示，
  // 按现名去找就找不到。
  it('旧名换成现名', () => {
    expect(zoneName('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(zoneName('Europe/Kiev')).toBe('Europe/Kyiv');
  });

  it('本来就是现名的不动', () => {
    expect(zoneName('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(zoneName('UTC')).toBe('UTC');
  });
});

describe('zoneMatches', () => {
  it('现名和旧名都搜得到', () => {
    expect(zoneMatches('Asia/Calcutta', 'Kolkata')).toBe(true);
    expect(zoneMatches('Asia/Calcutta', 'Calcutta')).toBe(true);
    expect(zoneMatches('Asia/Calcutta', 'asia/kol')).toBe(true);
  });

  it('只打城市名也搜得到，下划线和空格都行', () => {
    expect(zoneMatches('America/New_York', 'new york')).toBe(true);
    expect(zoneMatches('America/New_York', 'New_York')).toBe(true);
    expect(zoneMatches('America/New_York', 'york')).toBe(true);
  });

  it('不相干的不匹配，空串匹配一切', () => {
    expect(zoneMatches('Asia/Shanghai', 'york')).toBe(false);
    expect(zoneMatches('Asia/Shanghai', '')).toBe(true);
  });

  it('搜索用的那串字包含现名和旧名', () => {
    expect(zoneSearchText('Asia/Calcutta')).toContain('kolkata');
    expect(zoneSearchText('Asia/Calcutta')).toContain('calcutta');
  });
});
