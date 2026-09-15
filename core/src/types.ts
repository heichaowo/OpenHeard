// 纯类型。不依赖框架、数据库和 HTTP。
// 字段取自 specs/openheard.md。

/** 采集来源。决定这条记录能带哪些字段。 */
export type Origin = 'brandmeister' | 'sdr-fm' | 'sdr-dmr';

/** ADIF 模式。现在只产生 FM 和 DMR，HF 的等上了再加。 */
export type Mode = 'FM' | 'DMR';

/**
 * 观测到的一次发射，对应一次 PTT。
 * 自动写入，只追加，不手改。
 */
export interface Activity {
  /** 幂等键。BrandMeister 用它的 SessionID。 */
  id: string;
  origin: Origin;
  /** Unix 秒。 */
  startAt: number;
  durationS: number;
  /** 这次发射是不是自己。模拟侧靠 MDC-1200，数字侧靠 source ID。 */
  mine: boolean;
  /** 模拟侧是中继下行频率。网络会话没有射频，所以没有这个字段。 */
  freqMhz?: number;
  /** 信道名，来自部署配置的频谱表。 */
  channel?: string;
  /** 发射方呼号。配合 mine 判断是不是对方。模拟 FM 永远没有。 */
  callsign?: string;
  dmrId?: number;
  talkgroup?: number;
  /** 射频电平，dBm。过中继时它只描述中继，不要用来推 S。 */
  rssi?: number;
  ber?: number;
  /** 音频信噪比，dB。过中继时它携带对方的路径质量，用来推 R。 */
  audioSnrDb?: number;
}

/** 频谱表里的一条。属于部署配置，类型放这里是因为前后端都要用。 */
export interface Channel {
  name: string;
  freqMhz: number;
  mode: Mode;
}

/** 按间隔阈值把发射事件聚成的一次对话。 */
export interface Cluster {
  id: string;
  startAt: number;
  endAt: number;
  /** 按时间升序。 */
  activities: Activity[];
}

/**
 * 正式日志。每一行都由人的判断产生。
 * 手工录入的记录没有 clusterId，因为没有任何东西观测到它们。
 */
export interface Qso {
  id: string;
  /** 对方呼号。模拟侧由人填，这是待确认队列存在的唯一理由。 */
  call: string;
  /** Unix 秒。 */
  startAt: number;

  // LoTW 要求的字段
  freqMhz: number;
  band: string;
  mode: Mode;
  rstSent: string;
  rstRcvd: string;

  // 对方的信息，只能从空中听来
  gridsquare?: string;
  qth?: string;

  // 本台当时的配置。通联结束后再也拿不回来，所以每条都存一份
  myGridsquare?: string;
  myQth?: string;
  myDevice?: string;
  myAntenna?: string;
  myPower?: string;
  myHeightM?: number;

  note?: string;
  clusterId?: string;
  createdAt: number;
}

/** 机器能预填的部分。缺的字段就是人要补的。 */
export type QsoDraft = Partial<Omit<Qso, 'id' | 'createdAt'>>;

/** 待确认队列里的一项。 */
export interface PendingItem {
  cluster: Cluster;
  draft: QsoDraft;
}
