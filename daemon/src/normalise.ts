import type { Activity } from './core.ts';

/**
 * 一行 feed 转成 Activity。转不了就返回 undefined。
 *
 * 历史行和实时行形状不同：历史行的 Start/Stop 是字符串、没有 Event、
 * 未知呼号用 null、链路类型叫 LinkKind。两种都要吃得下，也不能假设 Event 存在。
 */
export function normalise(row: Record<string, unknown>, myDmrId?: number): Activity | undefined {
  const id = str(row.SessionID);
  if (id === undefined) return undefined;

  const startAt = num(row.Start);
  const stopAt = num(row.Stop);
  // 只收 Session-Stop 形状的行。只有它同时带起止时间，而 durationS 是必填的。
  if (startAt === undefined || stopAt === undefined || stopAt <= startAt) return undefined;

  const dmrId = num(row.SourceID);

  return {
    id,
    origin: 'brandmeister',
    startAt,
    durationS: stopAt - startAt,
    // 写入端会按配置里的 DMR ID 重算，这里只是让 --dry-run 的输出好读。
    mine: myDmrId !== undefined && dmrId === myDmrId,
    callsign: str(row.SourceCall),
    dmrId,
    talkgroup: num(row.DestinationID),
    rssi: num(row.RSSI),
    ber: num(row.BER),
  };
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}
