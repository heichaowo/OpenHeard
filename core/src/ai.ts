// AI 识别结果怎么进草稿、怎么算无意义。纯函数：api 在建对话时用，web 在挑一部分
// 发射重算草稿时也用，两边得是同一套规则，否则抽屉里和直接入库记的不一样。
import { isValidCallsign, normalizeCallsign } from './callsign.ts';
import type { QsoField } from './draft.ts';
import type { Activity, ActivityAi, ConversationStatus, HeardItem, QsoDraft } from './types.ts';

export interface AiFill {
  fields: Partial<QsoDraft>;
  /** 哪几个字段是 AI 填的，顺序固定。 */
  filled: QsoField[];
}

/** AI 提取出来的呼号：规整成大写，不像呼号的丢掉。api 入库时丢过一遍，这里再挡一次。 */
const callOf = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const call = normalizeCallsign(v);
  return isValidCallsign(call) ? call : undefined;
};

/**
 * 从这几次发射的识别结果里挑出能填进草稿的字段。
 *
 * 说话的人是本台时 fields.call 是本台自己，对方的呼号在 calledCall 里；说话的人
 * 是对方时反过来。两路合起来数，本台自己的呼号剔掉，剩下出现最多的就是对方，
 * 一样多取更晚的那次发射。四个字段都只取对方说的最新一次：本台说的 QTH 是本台的。
 *
 * @param members 按时间升序。
 * @param aiById 发射 id 到识别结果。
 * @param myCall 本台呼号，识别时常把两边的呼号说反，所以要剔掉。
 */
export function aiFill(
  members: Activity[],
  aiById: Map<string, ActivityAi>,
  myCall: string | undefined,
): AiFill {
  const mine = myCall === undefined || myCall === '' ? undefined : normalizeCallsign(myCall);
  const fields: Partial<QsoDraft> = {};
  const filled: QsoField[] = [];

  const count = new Map<string, { n: number; last: number }>();
  const theirs: { f: NonNullable<ActivityAi['fields']> }[] = [];
  let rstSent: string | undefined;
  members.forEach((a, i) => {
    const f = aiById.get(a.id)?.fields;
    if (f === undefined) return;
    const call = callOf(a.mine ? f.calledCall : f.call);
    if (call !== undefined && call !== mine) {
      const c = count.get(call);
      count.set(call, { n: (c?.n ?? 0) + 1, last: i });
    }
    if (a.mine) {
      if (f.rst !== undefined) rstSent = f.rst;
    } else {
      theirs.push({ f });
    }
  });

  let best: [string, { n: number; last: number }] | undefined;
  for (const entry of count) {
    if (best === undefined || entry[1].n > best[1].n || (entry[1].n === best[1].n && entry[1].last > best[1].last)) {
      best = entry;
    }
  }
  if (best !== undefined) {
    fields.call = best[0];
    filled.push('call');
  }

  const latest = (pick: (f: NonNullable<ActivityAi['fields']>) => string | undefined): string | undefined => {
    for (let i = theirs.length - 1; i >= 0; i--) {
      const v = pick(theirs[i]!.f);
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  };

  const qth = latest((f) => f.qth);
  if (qth !== undefined) {
    fields.qth = qth;
    filled.push('qth');
  }
  const rstRcvd = latest((f) => f.rst);
  if (rstRcvd !== undefined) {
    fields.rstRcvd = rstRcvd;
    filled.push('rstRcvd');
  }
  if (rstSent !== undefined && rstSent !== '') {
    fields.rstSent = rstSent;
    filled.push('rstSent');
  }

  const parts: string[] = [];
  const device = latest((f) => f.device);
  const antenna = latest((f) => f.antenna);
  const power = latest((f) => f.power);
  const height = latest((f) => f.height);
  if (device !== undefined) parts.push(`对方设备 ${device}`);
  if (antenna !== undefined) parts.push(`天线 ${antenna}`);
  if (power !== undefined) parts.push(`功率 ${power}`);
  if (height !== undefined) parts.push(`高度 ${height}`);
  if (parts.length > 0) {
    fields.note = parts.join('，');
    filled.push('note');
  }
  return { fields, filled };
}

/**
 * 把 AI 的填充落到草稿上，只填现有规则留空或者只给了缺省值的字段。
 * 报告缺省是 59：草稿里还是 59 就当没人填过。
 */
export function applyAiFill(draft: QsoDraft, fill: AiFill): { draft: QsoDraft; filled: QsoField[] } {
  const out = { ...draft };
  const filled: QsoField[] = [];
  for (const key of fill.filled) {
    const value = fill.fields[key];
    const taken =
      key === 'rstSent' || key === 'rstRcvd' ? out[key] !== undefined && out[key] !== '59' : out[key] !== undefined && out[key] !== '';
    if (taken || value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
    filled.push(key);
  }
  return { draft: out, filled };
}

/** 成员身上挂着的识别结果，收成 aiFill 要的那张表。 */
export function aiMapOf(members: HeardItem[]): Map<string, ActivityAi> {
  const out = new Map<string, ActivityAi>();
  for (const a of members) if (a.ai !== undefined) out.set(a.id, a.ai);
  return out;
}

/**
 * 这段对话是不是无意义：没入库，没有成员入过库，每一次发射的生效判定都是无意义。
 * 没有识别结果的成员（还没处理、数字侧）不算无意义。已入库的永远不算，人已经看过了。
 */
export function isMeaninglessConversation(status: ConversationStatus, members: HeardItem[]): boolean {
  if (status === 'logged') return false;
  if (members.length === 0) return false;
  return members.every((a) => a.settled !== 'logged' && a.ai?.meaningless === true);
}
