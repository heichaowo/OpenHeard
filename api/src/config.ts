import { readFileSync } from 'node:fs';
import type { Channel, StationDefaults } from './core.ts';

/** searchHouse 的一条查询。每条规则单独发一次，不用 OR 合并。 */
export interface Query {
  /** 日志里的标识，例如 `dst:91`。 */
  key: string;
  rule: { id: string; operator: string; value: number | string };
  amount: number;
  intervalS: number;
}

export interface Config {
  dbPath: string;
  /** 本台 DMR ID。数字侧靠它判断一条发射是不是自己。 */
  dmrId: number;
  /** 聚类间隔阈值，秒。要来自实测，所以没有默认值。 */
  clusterGapS: number;
  /** 待确认队列只看这么多天内的发射。 */
  pendingWindowDays: number;
  /** activity 的保留期。qso 不裁剪。 */
  activityRetentionDays: number;
  /** 采集入口的 Bearer token。 */
  ingestToken: string;
  station: StationDefaults;
  channels: Channel[];
  queries: Query[];
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; problems: string[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const posNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * 读配置并校验。
 *
 * 返回结果而不是抛错，因为调用方要先把服务起起来再报错。
 * launchd 的 KeepAlive 会把「配置错就退出」变成一个每 30 秒重复一次、
 * 谁也看不见的重启循环。
 */
export function loadConfig(path: string): ConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { ok: false, problems: [`读不了配置 ${path}：${(e as Error).message}`] };
  }
  if (!isObject(raw)) return { ok: false, problems: ['配置的顶层不是对象'] };

  const problems: string[] = [];

  if (typeof raw.dbPath !== 'string' || raw.dbPath === '') problems.push('dbPath 必填');
  if (!posNumber(raw.dmrId)) problems.push('dmrId 必填，是本台在 radioid.net 的 7 位 ID');
  if (!posNumber(raw.clusterGapS)) {
    problems.push('clusterGapS 必填，单位秒。这个值要来自对真实流量的实测，没有默认值');
  }
  if (!posNumber(raw.pendingWindowDays)) problems.push('pendingWindowDays 必填，单位天');
  if (!posNumber(raw.activityRetentionDays)) problems.push('activityRetentionDays 必填，单位天');
  if (typeof raw.ingestToken !== 'string' || raw.ingestToken.length < 16) {
    problems.push('ingestToken 必填，至少 16 个字符');
  }
  if (!isObject(raw.station)) problems.push('station 必填');
  if (!Array.isArray(raw.channels)) problems.push('channels 必填，可以是空数组');

  const queries = raw.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    problems.push('queries 必填，至少一条');
  } else {
    queries.forEach((q, i) => {
      if (!isObject(q)) return problems.push(`queries[${i}] 不是对象`);
      if (typeof q.key !== 'string' || q.key === '') problems.push(`queries[${i}].key 必填`);
      if (!posNumber(q.amount)) problems.push(`queries[${i}].amount 必填`);
      if (!posNumber(q.intervalS)) problems.push(`queries[${i}].intervalS 必填`);
      if (!isObject(q.rule)) return problems.push(`queries[${i}].rule 必填`);
      if (typeof q.rule.id !== 'string') problems.push(`queries[${i}].rule.id 必填`);
      if (typeof q.rule.operator !== 'string') problems.push(`queries[${i}].rule.operator 必填`);
      // 数值字段传字符串会静默返回 0 行，所以在这里就拦住。
      if (/ID$/.test(String(q.rule.id)) && typeof q.rule.value !== 'number') {
        problems.push(`queries[${i}].rule.value 必须是 JSON 数字，传字符串会静默返回空集`);
      }
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: raw as unknown as Config };
}
