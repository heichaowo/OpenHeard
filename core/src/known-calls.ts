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
