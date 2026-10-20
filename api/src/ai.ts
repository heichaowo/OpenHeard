// AI 识别结果的存取：写入时验、合并，读出来时把人工判定算进去，再就是识别队列。
//
// 守护进程里的识别是排队做的，它向这里要「还没做的录音」，做完推结果回来。
// 判无意义的规则只有一处（aiVerdict）：写入时算好存下，读的时候不再重算。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isValidCallsign, normalizeCallsign } from './core.ts';
import type { Activity, ActivityAi, AiFields } from './core.ts';
import { rowToActivity, withTx } from './db.ts';

export type AiStep = 'vad' | 'asr' | 'text';
export const AI_STEPS: AiStep[] = ['vad', 'asr', 'text'];

/** 守护进程推上来的一条。字段都可选：后一步只补自己那几列。 */
export interface AiResult {
  activityId: string;
  hasSpeech?: boolean;
  transcript?: string;
  category?: 'qso' | 'test' | 'noise';
  fields?: AiFields;
  asrModel?: string;
  textModel?: string;
  error?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const CATEGORIES = ['qso', 'test', 'noise'];
const RST = /^[1-5][1-9][1-9]?$/;
const POWER = /^\d+(\.\d+)?W$/;

/** 出错、没有人声、或者文字模型判成测试和噪声，才算无意义。出错的不算：不知道。 */
export function aiVerdict(r: { error?: string | null; hasSpeech?: boolean | null; category?: string | null }): boolean {
  if (r.error !== undefined && r.error !== null) return false;
  return r.hasSpeech === false || r.category === 'test' || r.category === 'noise';
}

const clip = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, max);
  return s === '' ? undefined : s;
};

function cleanFields(v: unknown): AiFields | undefined {
  if (!isObject(v)) return undefined;
  const out: AiFields = {};
  for (const k of ['call', 'calledCall'] as const) {
    const s = clip(v[k], 100);
    // 模型常把两边的呼号说反、也会编出不像呼号的东西，挡在入库之前。
    if (s !== undefined && isValidCallsign(s)) out[k] = normalizeCallsign(s);
  }
  for (const k of ['qth', 'device', 'antenna', 'height'] as const) {
    const s = clip(v[k], 100);
    if (s !== undefined) out[k] = s;
  }
  const rst = clip(v.rst, 100);
  if (rst !== undefined && RST.test(rst)) out.rst = rst;
  const power = clip(v.power, 100);
  if (power !== undefined && POWER.test(power)) out.power = power;
  return out;
}

/** 验一条。activityId 不是字符串的整条丢掉，别的字段不合格就只丢那一个。 */
export function cleanAiResult(raw: unknown): AiResult | undefined {
  if (!isObject(raw) || typeof raw.activityId !== 'string' || raw.activityId === '') return undefined;
  const r: AiResult = { activityId: raw.activityId };
  if (typeof raw.hasSpeech === 'boolean') r.hasSpeech = raw.hasSpeech;
  // 空串要留着：识别跑过了但什么都没听出来，和没跑过不一样。
  if (typeof raw.transcript === 'string') r.transcript = raw.transcript.trim().slice(0, 4000);
  if (typeof raw.category === 'string' && CATEGORIES.includes(raw.category)) {
    r.category = raw.category as AiResult['category'];
  }
  const fields = cleanFields(raw.fields);
  if (fields !== undefined) r.fields = fields;
  const asrModel = clip(raw.asrModel, 100);
  if (asrModel !== undefined) r.asrModel = asrModel;
  const textModel = clip(raw.textModel, 100);
  if (textModel !== undefined) r.textModel = textModel;
  const error = clip(raw.error, 300);
  if (error !== undefined) r.error = error;
  return r;
}

const nul = <T>(v: T | undefined) => (v === undefined ? null : v);

/**
 * 写一批结果。同一个发射 id 合并进已有的那一行：后一步只填自己的列，不擦掉前面的。
 * 发射不存在（被裁、被删留下墓碑、或者根本没有）的结果丢掉，不算 written。
 * at 一律用服务端的时刻，重试间隔靠它算。
 */
export function writeAiResults(db: DatabaseSync, raws: unknown[], now: number): number {
  const exists = db.prepare('SELECT 1 FROM activity WHERE id = ?');
  const stored = db.prepare('SELECT * FROM activity_ai WHERE activity_id = ?');
  const put = db.prepare(`
    INSERT OR REPLACE INTO activity_ai
      (activity_id, at, attempts, has_speech, transcript, category, fields,
       meaningless, asr_model, text_model, error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  return withTx(db, () => {
    let written = 0;
    for (const raw of raws) {
      const r = cleanAiResult(raw);
      if (r === undefined || exists.get(r.activityId) === undefined) continue;
      const old = stored.get(r.activityId) as Record<string, unknown> | undefined;

      const hasSpeech = r.hasSpeech ?? (old?.has_speech == null ? undefined : old.has_speech === 1);
      const category = r.category ?? (old?.category == null ? undefined : String(old.category));
      const error = r.error;
      // 上一次是错，这一次是重试。上一次没错，这是后一步补自己的列，不算重试。
      const attempts = old === undefined ? 1 : old.error != null ? Number(old.attempts) + 1 : Number(old.attempts);
      put.run(
        r.activityId,
        now,
        attempts,
        hasSpeech === undefined ? null : hasSpeech ? 1 : 0,
        r.transcript ?? nul(old?.transcript as string | null | undefined),
        nul(category),
        r.fields === undefined ? nul(old?.fields as string | null | undefined) : JSON.stringify(r.fields),
        aiVerdict({ error, hasSpeech, category }) ? 1 : 0,
        r.asrModel ?? nul(old?.asr_model as string | null | undefined),
        r.textModel ?? nul(old?.text_model as string | null | undefined),
        nul(error),
      );
      written += 1;
    }
    return written;
  });
}

/** 设置页改了 ai 那一段，或者 api 重启：上次的错误多半是配置问题，清掉让队列重新做。 */
export function resetAiErrors(db: DatabaseSync): number {
  return Number(db.prepare('DELETE FROM activity_ai WHERE error IS NOT NULL').run().changes);
}

/** 人工判定。已经有的覆盖。 */
export function setVerdicts(db: DatabaseSync, ids: string[], meaningless: boolean, at: number): void {
  const put = db.prepare('INSERT OR REPLACE INTO activity_verdict (activity_id, meaningless, at) VALUES (?,?,?)');
  for (const id of ids) put.run(id, meaningless ? 1 : 0, at);
}

const CHUNK = 400;

/**
 * 这批发射的识别结果，人工判定算进去。没有结果也没有判定的 id 不在返回里。
 * 生效的 meaningless：判定压过 AI，都没有就是 false（不在返回里）。
 */
export function selectAiByIds(db: DatabaseSync, ids: string[]): Map<string, ActivityAi> {
  const out = new Map<string, ActivityAi>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const marks = part.map(() => '?').join(',');
    const verdicts = new Map<string, boolean>();
    for (const v of db
      .prepare(`SELECT activity_id, meaningless FROM activity_verdict WHERE activity_id IN (${marks})`)
      .all(...part) as { activity_id: string; meaningless: number }[]) {
      verdicts.set(v.activity_id, v.meaningless === 1);
    }
    const rows = db
      .prepare(`SELECT * FROM activity_ai WHERE activity_id IN (${marks})`)
      .all(...part) as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row.activity_id);
      const verdict = verdicts.get(id);
      const ai: ActivityAi = { meaningless: verdict ?? row.meaningless === 1 };
      if (row.has_speech !== null) ai.hasSpeech = row.has_speech === 1;
      if (row.transcript !== null) ai.transcript = String(row.transcript);
      if (row.category !== null) ai.category = row.category as ActivityAi['category'];
      if (row.fields !== null) ai.fields = JSON.parse(String(row.fields)) as AiFields;
      if (row.error !== null) ai.error = String(row.error);
      if (verdict !== undefined) ai.verdict = verdict ? 'meaningless' : 'keep';
      out.set(id, ai);
    }
    // 只有判定、没有识别结果的发射，也要让判定生效。
    for (const [id, verdict] of verdicts) {
      if (!out.has(id)) out.set(id, { meaningless: verdict, verdict: verdict ? 'meaningless' : 'keep' });
    }
  }
  return out;
}

/**
 * 无意义视图的种子：生效判定是无意义的发射。从 activity_ai 往 activity 连，
 * 走主键，25 万行的库上约 1 毫秒。反过来从 activity 扫过去要 158 毫秒。
 * 只有人工判定、还没有识别结果的发射另走一路，也是主键。
 */
export function selectMeaninglessSeeds(db: DatabaseSync, sinceStartAt: number, dmrId: number): Activity[] {
  const rows = db
    .prepare(`
      SELECT a.* FROM activity_ai ai
      JOIN activity a ON a.id = ai.activity_id
      LEFT JOIN activity_verdict v ON v.activity_id = ai.activity_id
      WHERE COALESCE(v.meaningless, ai.meaningless) = 1 AND a.start_at >= ?
      UNION
      SELECT a.* FROM activity_verdict v
      JOIN activity a ON a.id = v.activity_id
      WHERE v.meaningless = 1 AND a.start_at >= ?
    `)
    .all(sinceStartAt, sinceStartAt) as Record<string, unknown>[];
  return rows.map((r) => rowToActivity(r, dmrId));
}

/** 出错的行最多做这么多次，之后不再排进队列。 */
export const AI_MAX_ATTEMPTS = 3;
/** 出错后隔多久再试，秒。 */
export const AI_RETRY_AFTER_S = 3600;

export interface TodoItem {
  id: string;
  startAt: number;
  durationS: number;
  mine: boolean;
  channel?: string;
  /** 只在只差文字提取的那种行上有，守护进程据此跳过前面的步骤。 */
  hasSpeech?: boolean;
  transcript?: string;
}

const PAGE = 50;

/**
 * 逐页读候选行，只对候选检查录音在不在，凑够 limit 条就停。
 *
 * 候选条件见合同 §5：没有结果；出错且还能重试；有人声、识别开着、还没识别；
 * 有人声、提取开着、有转写、还没提取。录音不在的行不返回（对应的 wav 可能被删了）。
 * 走 activity_origin 索引，从新往旧读，不扫整张 activity。
 */
function* todoRows(
  db: DatabaseSync,
  o: { steps: Set<AiStep>; sinceStartAt: number; now: number; recordingsDir: string | undefined },
): Generator<TodoItem> {
  const asr = o.steps.has('asr') ? 1 : 0;
  const text = o.steps.has('text') ? 1 : 0;
  const sql = `
    SELECT a.rowid AS rid, a.id, a.start_at, a.duration_s, a.mine, a.channel,
           ai.has_speech, ai.transcript, ai.error, ai.text_model
    FROM activity a LEFT JOIN activity_ai ai ON ai.activity_id = a.id
    WHERE a.origin = 'sdr-fm' AND a.start_at >= ?
      AND (a.start_at < ? OR (a.start_at = ? AND a.rowid < ?))
      AND (
        ai.activity_id IS NULL
        OR (ai.error IS NOT NULL AND ai.attempts < ${AI_MAX_ATTEMPTS} AND ai.at < ?)
        OR (ai.error IS NULL AND ai.has_speech IS NOT 0 AND ${asr} = 1 AND ai.asr_model IS NULL)
        OR (ai.error IS NULL AND ai.has_speech IS NOT 0 AND ${text} = 1
            AND ai.transcript IS NOT NULL AND ai.transcript <> '' AND ai.text_model IS NULL)
      )
    ORDER BY a.start_at DESC, a.rowid DESC
    LIMIT ${PAGE}
  `;
  const stmt = db.prepare(sql);
  let beforeStart = Number.MAX_SAFE_INTEGER;
  let beforeRid = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = stmt.all(o.sinceStartAt, beforeStart, beforeStart, beforeRid, o.now - AI_RETRY_AFTER_S) as Record<
      string,
      unknown
    >[];
    for (const r of rows) {
      const id = String(r.id);
      // 目录是 api 自己配的，id 来自库，这里再挡一道别跑出目录。
      if (o.recordingsDir === undefined || !/^[A-Za-z0-9_-]{1,120}$/.test(id)) continue;
      if (!existsSync(join(o.recordingsDir, `${id}.wav`))) continue;
      const item: TodoItem = {
        id,
        startAt: Number(r.start_at),
        durationS: Number(r.duration_s),
        mine: r.mine === 1,
      };
      if (r.channel !== null) item.channel = String(r.channel);
      const onlyText =
        text === 1 &&
        r.error === null &&
        r.has_speech !== 0 &&
        r.transcript !== null &&
        r.transcript !== '' &&
        r.text_model === null;
      if (onlyText) {
        if (r.has_speech !== null) item.hasSpeech = r.has_speech === 1;
        item.transcript = String(r.transcript);
      }
      yield item;
    }
    const last = rows.at(-1);
    if (rows.length < PAGE || last === undefined) return;
    beforeStart = Number(last.start_at);
    beforeRid = Number(last.rid);
  }
}

export function selectTodo(
  db: DatabaseSync,
  o: { steps: Set<AiStep>; sinceStartAt: number; now: number; recordingsDir: string | undefined; limit: number },
): TodoItem[] {
  const out: TodoItem[] = [];
  for (const item of todoRows(db, o)) {
    out.push(item);
    if (out.length >= o.limit) break;
  }
  return out;
}

export function countTodo(
  db: DatabaseSync,
  o: { steps: Set<AiStep>; sinceStartAt: number; now: number; recordingsDir: string | undefined },
): number {
  let n = 0;
  for (const _ of todoRows(db, o)) n += 1;
  return n;
}

/** 运维页用：最近 24 小时做完了多少，最近一次出错是什么。 */
export function aiStats(db: DatabaseSync, now: number): { doneLast24h: number; lastError?: { at: number; message: string } } {
  const done = db
    .prepare('SELECT COUNT(*) AS n FROM activity_ai WHERE error IS NULL AND at >= ?')
    .get(now - 86400) as { n: number };
  const last = db
    .prepare('SELECT at, error FROM activity_ai WHERE error IS NOT NULL ORDER BY at DESC LIMIT 1')
    .get() as { at: number; error: string } | undefined;
  return {
    doneLast24h: Number(done.n),
    ...(last === undefined ? {} : { lastError: { at: Number(last.at), message: String(last.error) } }),
  };
}
