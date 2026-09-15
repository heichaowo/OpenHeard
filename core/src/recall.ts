import { normalizeCallsign } from './callsign.ts';
import type { Qso } from './types.ts';

export interface Recalled {
  qth?: string;
  gridsquare?: string;
  /** 上次和这个呼号通联的时刻，Unix 秒 UTC。 */
  lastAt: number;
}

/**
 * 上次和这个呼号通联时记下的 QTH 和网格。
 *
 * 数据本来就在日志里，不用另存一份字典。本地中继上会重复遇到的就那几个人，
 * 每次重新打一遍他的 QTH 没有道理。
 *
 * 只看最近一条带内容的，不合并多条：地址会变，旧的那条不该盖住新的。
 */
export function recallStation(qsos: Qso[], call: string): Recalled | undefined {
  const want = normalizeCallsign(call);
  if (!want) return undefined;

  let best: Qso | undefined;
  for (const q of qsos) {
    if (q.call !== want) continue;
    if (q.qth === undefined && q.gridsquare === undefined) continue;
    if (best === undefined || q.startAt > best.startAt) best = q;
  }

  return best === undefined
    ? undefined
    : { qth: best.qth, gridsquare: best.gridsquare, lastAt: best.startAt };
}
