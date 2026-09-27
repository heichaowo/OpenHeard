import type { Activity } from './types.ts';

/**
 * DMR ID 到呼号的对照，全部来自自己收过的东西。
 *
 * BrandMeister 大多数时候会带 SourceCall，但不是每一条都带。少了的那几条，
 * 草稿里的呼号就是空的，人得手打，哪怕这个 ID 我们早就见过呼号了。
 *
 * 不查任何外部服务。radioid.net 要联网，而这台机器在国内、无人值守，
 * 为了补一个字段引一条外部依赖不划算。
 */
export function knownCalls(activities: Activity[]): Map<number, string> {
  const seen = new Map<number, string>();
  for (const a of activities) {
    if (a.dmrId === undefined || a.callsign === undefined || a.callsign === '') continue;
    seen.set(a.dmrId, a.callsign);
  }
  return seen;
}

/** 这个 DMR ID 见过的呼号。没见过就是 undefined。 */
export function callFor(known: Map<number, string>, dmrId: number | undefined): string | undefined {
  return dmrId === undefined ? undefined : known.get(dmrId);
}

/**
 * 这段对话要不要靠对照表补呼号：只有在没有任何非本台成员自带呼号时才需要。
 *
 * draftFromCluster 只在这种时候才去查 known map（见它的 `other` 那行），
 * 所以按整个保留期建一份完整对照表是在为大多数对话白算——它们自己就带着
 * 对方呼号。只把真正要查的 dmr id 收集出来，一个个用索引查，比建整表便宜
 * 几百倍。
 */
export function dmrIdsNeedingLookup(members: Activity[]): number[] {
  if (members.some((a) => !a.mine && a.callsign !== undefined && a.callsign !== '')) return [];
  return members
    .filter((a): a is Activity & { dmrId: number } => !a.mine && a.dmrId !== undefined)
    .map((a) => a.dmrId);
}
