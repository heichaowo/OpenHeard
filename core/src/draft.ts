import { bandOf, modeOf } from './band.ts';
import type { Cluster, Qso, QsoDraft } from './types.ts';

/** 本台的固定信息。属于部署配置，不是设计。 */
export interface StationDefaults {
  myGridsquare?: string;
  myQth?: string;
  myDevice?: string;
  myAntenna?: string;
  myPower?: string;
  myHeightM?: number;
  /** 网络会话没有射频频率，记账用这个。 */
  networkFreqMhz?: number;
}

/** 草稿里可以出现的字段。id 和 createdAt 由入库时生成。 */
export type QsoField = Exclude<keyof Qso, 'id' | 'createdAt'>;

/** 少一个都进不了日志。 */
const REQUIRED: QsoField[] = [
  'call',
  'startAt',
  'freqMhz',
  'band',
  'mode',
  'rstSent',
  'rstRcvd',
];

/**
 * 把一次对话预填成通联草稿。
 *
 * 信号报告一律给 59。对方给我们的报告只在空中说出口，机器拿不到；
 * 我们给对方的报告要靠音频信噪比推 R，而阈值还没有实测数据。
 */
export function draftFromCluster(
  cluster: Cluster,
  defaults: StationDefaults = {},
): QsoDraft {
  const first = cluster.activities[0];
  const other = cluster.activities.find((a) => !a.mine && a.callsign);
  const freqMhz =
    cluster.activities.find((a) => a.freqMhz !== undefined)?.freqMhz ??
    defaults.networkFreqMhz;

  return {
    call: other?.callsign,
    startAt: cluster.startAt,
    freqMhz,
    band: freqMhz === undefined ? undefined : bandOf(freqMhz),
    mode: first === undefined ? undefined : modeOf(first.origin),
    rstSent: '59',
    rstRcvd: '59',
    myGridsquare: defaults.myGridsquare,
    myQth: defaults.myQth,
    myDevice: defaults.myDevice,
    myAntenna: defaults.myAntenna,
    myPower: defaults.myPower,
    myHeightM: defaults.myHeightM,
    clusterId: cluster.id,
  };
}

/** 还缺哪些必填字段。空数组表示可以直接提升。 */
export function missingFields(draft: QsoDraft): QsoField[] {
  return REQUIRED.filter((key) => {
    const value = draft[key];
    return value === undefined || value === '';
  });
}
