/**
 * BrandMeister 查询的校验。
 *
 * api 和 daemon 各自解析同一份配置文件，两边互不依赖。校验规则放在这里，
 * 是因为两边各写一份就会长歪：daemon 原来只检查 queries 是个非空数组，
 * 于是一份 api 拒绝的配置在 daemon 那边照样起来，带着缺 key 的查询去轮询。
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const posNumber = (v: unknown): v is number => typeof v === 'number' && v > 0;

/** 返回问题清单，空数组表示没问题。 */
export function checkQueries(queries: unknown): string[] {
  if (!Array.isArray(queries) || queries.length === 0) return ['queries 必填，至少一条'];

  const problems: string[] = [];
  queries.forEach((q, i) => {
    if (!isObject(q)) {
      problems.push(`queries[${i}] 不是对象`);
      return;
    }
    if (typeof q.key !== 'string' || q.key === '') problems.push(`queries[${i}].key 必填`);
    if (!posNumber(q.amount)) problems.push(`queries[${i}].amount 必填`);
    if (!posNumber(q.intervalS)) problems.push(`queries[${i}].intervalS 必填`);
    if (!isObject(q.rule)) {
      problems.push(`queries[${i}].rule 必填`);
      return;
    }
    if (typeof q.rule.id !== 'string') problems.push(`queries[${i}].rule.id 必填`);
    if (typeof q.rule.operator !== 'string') problems.push(`queries[${i}].rule.operator 必填`);
    // 数值字段传字符串会静默返回 0 行，所以在这里就拦住。
    if (/ID$/.test(String(q.rule.id)) && typeof q.rule.value !== 'number') {
      problems.push(`queries[${i}].rule.value 必须是 JSON 数字，传字符串会静默返回空集`);
    }
  });
  return problems;
}
