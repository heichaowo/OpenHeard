import type { Activity, Cluster } from './types';

/** 一次发射的结束时刻。 */
const endOf = (a: Activity) => a.startAt + a.durationS;

/**
 * 按间隔阈值把发射事件切成一次次对话。
 *
 * 间隔量的是静默，也就是上一次发射结束到下一次发射开始。
 * 用起点到起点会把一次长发射本身算成间隔。
 *
 * cluster.id 取段内最早那条 activity 的 id。它只够用来在一次请求往返里
 * 指认这一段，提升和忽略记在成员行上，不记在这个 id 上。
 */
export function clusterActivities(
  activities: Activity[],
  gapThresholdS: number,
): Cluster[] {
  if (activities.length === 0) return [];

  const sorted = [...activities].sort(
    (a, b) => a.startAt - b.startAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const clusters: Cluster[] = [];
  let members: Activity[] = [];
  let openUntil = 0;

  const flush = () => {
    if (members.length === 0) return;
    clusters.push({
      id: members[0]!.id,
      startAt: members[0]!.startAt,
      endAt: openUntil,
      activities: members,
    });
    members = [];
  };

  for (const a of sorted) {
    if (members.length > 0 && a.startAt - openUntil > gapThresholdS) flush();
    members.push(a);
    openUntil = members.length === 1 ? endOf(a) : Math.max(openUntil, endOf(a));
  }
  flush();

  return clusters;
}
