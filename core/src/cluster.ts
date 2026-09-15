import type { Activity, Cluster } from './types.ts';

/** 一次发射的结束时刻。 */
const endOf = (a: Activity) => a.startAt + a.durationS;

/**
 * 这次发射走的是哪条信道。
 *
 * 同一时刻本台可能既在中继上说话又在话务组上说话，那是两次不相干的对话。
 * 只按时间聚会把它们并成一段，提升出来的通联会混着模拟信道和数字话务组。
 */
export function channelKey(a: Activity): string {
  if (a.talkgroup !== undefined) return `tg:${a.talkgroup}`;
  if (a.channel !== undefined) return `ch:${a.channel}`;
  if (a.freqMhz !== undefined) return `fq:${a.freqMhz}`;
  return a.origin;
}

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

  // 先按信道分开，再在每条信道内部按间隔切。
  const byChannel = new Map<string, Activity[]>();
  for (const a of activities) {
    const k = channelKey(a);
    const list = byChannel.get(k);
    if (list) list.push(a);
    else byChannel.set(k, [a]);
  }
  if (byChannel.size > 1) {
    return [...byChannel.values()]
      .flatMap((list) => clusterActivities(list, gapThresholdS))
      .sort((x, y) => x.startAt - y.startAt);
  }

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
