// 把发射行组成对话，五档共用同一套算法。纯函数，不碰数据库：按天看、未入库、
// 搜索三个视图都要用同一批规则，写两遍迟早会长歪。
//
// 待确认/未入库/旁听按间隔阈值聚类（clusterActivities）；已入库按 qso_id 分组，
// 不按间隔切，因为它的成员早就由 resolved_activity 定死了；已忽略再按间隔聚类，
// 但只在忽略过的行里聚，不和前两档混在一起。混在一起聚会让同一次入库操作
// 因为旁边多了一条未结算的行而在两次请求之间换 id。
import { channelKey, clusterActivities } from './cluster.ts';
import { draftFromCluster } from './draft.ts';
import type { StationDefaults } from './draft.ts';
import type { Activity, Cluster, Conversation, ConversationStatus, HeardItem } from './types.ts';

/**
 * 没结算的对话属于哪一档。
 *
 * pending：有本台成员，且至少一个还在待确认窗口内。
 * unlogged：有本台成员，但全部出了窗口。
 * overheard：没有本台成员。
 *
 * 判据和 /api/pending 今天用的完全一样（严格大于），否则同一次对话在两个
 * 视图里会分到不同的档。
 */
export function unresolvedStatus(
  members: Activity[],
  now: number,
  pendingWindowS: number,
): 'pending' | 'unlogged' | 'overheard' {
  const mine = members.filter((a) => a.mine);
  if (mine.length === 0) return 'overheard';
  return mine.some((a) => a.startAt > now - pendingWindowS) ? 'pending' : 'unlogged';
}

/** 一次发射的结束时刻。和 cluster.ts 里那个私有的重复，但没必要为它导出一整个模块。 */
const endOf = (a: Activity) => a.startAt + a.durationS;

const byStartThenId = (a: Activity, b: Activity) =>
  a.startAt - b.startAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 把同一个 qso 下的成员包成一个 Cluster 形状，不做间隔切分。
 *
 * 已入库对话的成员是 resolved_activity 定死的，不是猜出来的，所以没有「边界
 * 碰到窗口要不要接着读」这回事，也就不需要链式扩展。
 */
export function clusterOfGroup(members: Activity[]): Cluster {
  const sorted = [...members].sort(byStartThenId);
  const first = sorted[0]!;
  return {
    id: first.id,
    startAt: first.startAt,
    endAt: Math.max(...sorted.map(endOf)),
    activities: sorted,
  };
}

/** 按 qso_id 分组。返回值的键是 qso_id。 */
export function groupByQso(rows: { activity: Activity; qsoId: string }[]): Map<string, Activity[]> {
  const out = new Map<string, Activity[]>();
  for (const { activity, qsoId } of rows) {
    const list = out.get(qsoId);
    if (list) list.push(activity);
    else out.set(qsoId, [activity]);
  }
  return out;
}

export interface ConversationOpts {
  defaults?: StationDefaults;
  known?: Map<number, string>;
  qso?: { id: string; call: string; rstSent: string; rstRcvd: string };
}

/** 把一个 Cluster 包成 Conversation。草稿只在没结算的三档上算，已入库/已忽略不需要。 */
export function toConversation(cluster: Cluster, status: ConversationStatus, opts: ConversationOpts = {}): Conversation {
  const first = cluster.activities[0]!;
  const needsDraft = status === 'pending' || status === 'unlogged' || status === 'overheard';
  return {
    id: cluster.id,
    startAt: cluster.startAt,
    endAt: cluster.endAt,
    channel: channelKey(first),
    origin: first.origin,
    status,
    activities: cluster.activities as HeardItem[],
    qso: opts.qso,
    draft: needsDraft ? draftFromCluster(cluster, opts.defaults, opts.known) : undefined,
  };
}

/** 一段种子时刻按半宽合并成互不重叠的区间。未入库和搜索的每信道窗口都靠它。 */
export function mergeWindows(seedTimes: number[], halfWidthS: number): { start: number; end: number }[] {
  if (seedTimes.length === 0) return [];
  const sorted = [...seedTimes].sort((a, b) => a - b);
  const out: { start: number; end: number }[] = [];
  for (const s of sorted) {
    const w = { start: s - halfWidthS, end: s + halfWidthS };
    const last = out.at(-1);
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push(w);
  }
  return out;
}

/** 一条信道的第一行是不是碰到了读取窗口的起点，碰到了就要往前多读一段。 */
export function touchesWindowStart(firstMemberStartAt: number, windowStart: number, gapThresholdS: number): boolean {
  return firstMemberStartAt - windowStart <= gapThresholdS;
}

/** 一条信道的最后一行是不是碰到了读取窗口的终点，碰到了就要往后多读一段。 */
export function touchesWindowEnd(lastMemberEndAt: number, windowEnd: number, gapThresholdS: number): boolean {
  return windowEnd - lastMemberEndAt <= gapThresholdS;
}

/** 往外扩一次读取窗口的步长。和天视图两头各多取的那两小时一致。 */
export const EXTEND_STEP_S = 7200;

/**
 * 对一条信道反复扩窗重聚，直到两头都碰不到真正的停顿为止。
 *
 * 只在单条信道内部工作：不同信道的对话本来就不该合并，调用方按 channelKey
 * 分组之后一条条信道各自调用。`readMore` 是唯一碰「外部数据」的缝，测试里
 * 传一个只读内存数组的假函数，生产代码里它背后是一次按信道的索引查询。
 */
export function extendChannel(
  initialActivities: Activity[],
  windowStart: number,
  windowEnd: number,
  gapThresholdS: number,
  readMore: (from: number, to: number) => Activity[],
): Cluster[] {
  if (initialActivities.length === 0) return [];
  let acts = initialActivities;
  let lo = windowStart;
  let hi = windowEnd;
  for (;;) {
    const clusters = clusterActivities(acts, gapThresholdS);
    const first = clusters[0]!;
    const last = clusters.at(-1)!;
    const extendBefore = touchesWindowStart(first.startAt, lo, gapThresholdS);
    const extendAfter = touchesWindowEnd(last.endAt, hi, gapThresholdS);
    if (!extendBefore && !extendAfter) return clusters;

    if (extendBefore) {
      const newLo = lo - EXTEND_STEP_S;
      acts = acts.concat(readMore(newLo, lo));
      lo = newLo;
    }
    if (extendAfter) {
      const newHi = hi + EXTEND_STEP_S;
      acts = acts.concat(readMore(hi, newHi));
      hi = newHi;
    }
  }
}

/**
 * 搜索按种子时刻从新到旧分批取。已经出现在更早批次窗口里的对话，只有在确定
 * 不会再被更旧的种子拉长之后才能定型下发，否则同一次对话会在两页里各出现
 * 一次，startAt 和成员都不一样（contract-review 记录过这个坑）。
 *
 * 一次对话定型的判据：它的 startAt 不早于下一个还没读到的种子的 start_at。
 * 更旧的种子哪怕落进同一条信道的窗口，也不可能把 startAt 更晚的对话往前拉，
 * 只会生出它自己那一段。`nextUnreadSeedStartAt` 是 undefined 时说明种子已经
 * 取完了，剩下的全部定型。
 */
export function finalConversations(clusters: Cluster[], nextUnreadSeedStartAt: number | undefined): Cluster[] {
  if (nextUnreadSeedStartAt === undefined) return clusters;
  return clusters.filter((c) => c.startAt >= nextUnreadSeedStartAt);
}
