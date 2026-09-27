import { describe, expect, it } from 'vitest';
import { checkQueries } from './queries.ts';

const good = { key: 'dst:91', amount: 200, intervalS: 900, rule: { id: 'DestinationID', operator: 'equal', value: 91 } };

describe('checkQueries', () => {
  it('默认必填：空或者不是数组都不收', () => {
    expect(checkQueries(undefined)).toEqual(['queries 必填，至少一条']);
    expect(checkQueries([])).toEqual(['queries 必填，至少一条']);
    expect(checkQueries('x')).toEqual(['queries 必填，至少一条']);
  });

  it('一条合规的没有问题', () => {
    expect(checkQueries([good])).toEqual([]);
  });

  it('数值字段传字符串会被拦住', () => {
    const bad = { ...good, rule: { ...good.rule, value: '91' } };
    expect(checkQueries([bad])[0]).toMatch(/JSON 数字/);
  });
});

describe('checkQueries：BrandMeister 关着时（required = false）', () => {
  it('缺失或空数组都不算错', () => {
    expect(checkQueries(undefined, false)).toEqual([]);
    expect(checkQueries([], false)).toEqual([]);
  });

  it('不是数组还是错', () => {
    expect(checkQueries('x', false)).toEqual(['queries 要是数组']);
  });

  it('传了的条目还是照样验', () => {
    const bad = { ...good, amount: undefined };
    expect(checkQueries([bad], false)[0]).toMatch(/amount/);
  });
});
