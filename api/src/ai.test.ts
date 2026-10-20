import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  aiStats,
  aiVerdict,
  cleanAiResult,
  countTodo,
  resetAiErrors,
  selectAiByIds,
  selectMeaninglessSeeds,
  selectTodo,
  setVerdicts,
  writeAiResults,
} from './ai.ts';
import type { AiStep } from './ai.ts';
import type { Activity } from './core.ts';
import { insertActivities, openDb } from './db.ts';

const NOW = Math.floor(Date.now() / 1000);

const fm = (id: string, startAt: number, over: Partial<Activity> = {}): Activity => ({
  id,
  origin: 'sdr-fm',
  startAt,
  durationS: 3,
  mine: false,
  freqMhz: 438.975,
  channel: '438.975 直频',
  ...over,
});

function setup(rows: Activity[]) {
  const db = openDb(':memory:');
  insertActivities(db, rows.map((a) => ({ activity: a, raw: '{}' })), 1);
  const dir = mkdtempSync(join(tmpdir(), 'openheard-ai-'));
  for (const r of rows) writeFileSync(join(dir, `${r.id}.wav`), 'RIFF');
  return { db, dir };
}

const steps = (...s: AiStep[]) => new Set(s);
const todoIds = (db: ReturnType<typeof openDb>, dir: string, s: Set<AiStep>, limit = 50) =>
  selectTodo(db, { steps: s, sinceStartAt: 0, now: NOW, recordingsDir: dir, limit }).map((i) => i.id);

describe('aiVerdict', () => {
  it('没有人声、测试、噪声是无意义', () => {
    assert.equal(aiVerdict({ hasSpeech: false }), true);
    assert.equal(aiVerdict({ category: 'test' }), true);
    assert.equal(aiVerdict({ category: 'noise' }), true);
  });

  it('通联、没提取、没开 VAD 都不是', () => {
    assert.equal(aiVerdict({ category: 'qso', hasSpeech: true }), false);
    assert.equal(aiVerdict({}), false);
    assert.equal(aiVerdict({ hasSpeech: null, category: null }), false);
  });

  it('出错的一律不是：不知道，不能藏', () => {
    assert.equal(aiVerdict({ error: 'x', hasSpeech: false, category: 'noise' }), false);
  });
});

describe('cleanAiResult', () => {
  it('呼号规整成大写，不像呼号的丢掉，报告和功率按格式', () => {
    const r = cleanAiResult({
      activityId: 'a',
      hasSpeech: true,
      category: 'qso',
      fields: { call: ' bd7abc ', calledCall: '你好', rst: '57', power: '5W', qth: ' 海淀 ', height: '30米' },
    })!;
    assert.deepEqual(r.fields, { call: 'BD7ABC', rst: '57', power: '5W', qth: '海淀', height: '30米' });
  });

  it('rst 和 power 不合格就丢，别的字段照留', () => {
    const r = cleanAiResult({ activityId: 'a', fields: { rst: '5个9', power: '五瓦', qth: '朝阳', device: 'UV-5R' } })!;
    assert.deepEqual(r.fields, { qth: '朝阳', device: 'UV-5R' });
    for (const rst of ['59', '579', '11', '55']) {
      assert.equal(cleanAiResult({ activityId: 'a', fields: { rst } })!.fields!.rst, rst);
    }
    for (const rst of ['09', '60', '5', '5999', '5 9']) {
      assert.equal(cleanAiResult({ activityId: 'a', fields: { rst } })!.fields!.rst, undefined);
    }
    for (const power of ['5W', '0.5W', '100W']) {
      assert.equal(cleanAiResult({ activityId: 'a', fields: { power } })!.fields!.power, power);
    }
    for (const power of ['5', '5 W', '5w', 'W', '5kW']) {
      assert.equal(cleanAiResult({ activityId: 'a', fields: { power } })!.fields!.power, undefined);
    }
  });

  it('category 不在枚举里就丢，hasSpeech 不是布尔就丢', () => {
    const r = cleanAiResult({ activityId: 'a', category: 'QSO', hasSpeech: 'yes' })!;
    assert.equal(r.category, undefined);
    assert.equal(r.hasSpeech, undefined);
  });

  it('不认识的键丢掉，字符串截断', () => {
    const r = cleanAiResult({
      activityId: 'a',
      transcript: '字'.repeat(5000),
      at: 5,
      fields: { qth: 'x'.repeat(300), secret: 'y' },
    })!;
    assert.equal(r.transcript!.length, 4000);
    assert.equal(r.fields!.qth!.length, 100);
    assert.deepEqual(Object.keys(r.fields!), ['qth']);
    assert.equal('at' in r, false);
  });

  it('没有 activityId 的整条丢掉', () => {
    assert.equal(cleanAiResult({ hasSpeech: true }), undefined);
    assert.equal(cleanAiResult({ activityId: 5 }), undefined);
    assert.equal(cleanAiResult('x'), undefined);
  });
});

describe('writeAiResults', () => {
  it('写一条，并由 api 自己算 meaningless 和 at', () => {
    const { db } = setup([fm('a', NOW - 100)]);
    const n = writeAiResults(db, [{ activityId: 'a', hasSpeech: false, at: 1 }], NOW);
    assert.equal(n, 1);
    const row = db.prepare('SELECT * FROM activity_ai').get() as Record<string, unknown>;
    assert.equal(row.meaningless, 1);
    assert.equal(row.at, NOW);
    assert.equal(row.attempts, 1);
    assert.equal(row.has_speech, 0);
  });

  it('后一步补自己的列，不擦掉前面的', () => {
    const { db } = setup([fm('a', NOW - 100)]);
    writeAiResults(db, [{ activityId: 'a', hasSpeech: true, transcript: '你好', asrModel: 'whisper' }], NOW);
    writeAiResults(db, [{ activityId: 'a', category: 'qso', fields: { call: 'BD7ABC' }, textModel: 'qwen' }], NOW + 5);
    const ai = selectAiByIds(db, ['a']).get('a')!;
    assert.equal(ai.hasSpeech, true);
    assert.equal(ai.transcript, '你好');
    assert.equal(ai.category, 'qso');
    assert.deepEqual(ai.fields, { call: 'BD7ABC' });
    const row = db.prepare('SELECT * FROM activity_ai').get() as Record<string, unknown>;
    assert.equal(row.asr_model, 'whisper');
    assert.equal(row.text_model, 'qwen');
    assert.equal(row.attempts, 1);
    assert.equal(ai.meaningless, false);
  });

  it('上一次是错，这一次成功：错误清掉，attempts 加一', () => {
    const { db } = setup([fm('a', NOW - 100)]);
    writeAiResults(db, [{ activityId: 'a', error: '网络' }], NOW);
    writeAiResults(db, [{ activityId: 'a', hasSpeech: false }], NOW + 4000);
    const row = db.prepare('SELECT * FROM activity_ai').get() as Record<string, unknown>;
    assert.equal(row.error, null);
    assert.equal(row.attempts, 2);
    assert.equal(row.meaningless, 1);
  });

  it('出错的行不算无意义', () => {
    const { db } = setup([fm('a', NOW - 100)]);
    writeAiResults(db, [{ activityId: 'a', hasSpeech: false, error: 'x' }], NOW);
    assert.equal(selectAiByIds(db, ['a']).get('a')!.meaningless, false);
  });

  it('不存在的发射和墓碑里的发射都丢掉，不算 written', () => {
    const { db } = setup([fm('a', NOW - 100)]);
    db.prepare('INSERT INTO deleted_activity (id, deleted_at) VALUES (?,?)').run('gone', NOW);
    const n = writeAiResults(db, [{ activityId: 'nope', hasSpeech: true }, { activityId: 'gone', hasSpeech: true }, { activityId: 'a', hasSpeech: true }], NOW);
    assert.equal(n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM activity_ai').get() as { n: number }).n, 1);
  });

  it('resetAiErrors 只清出错的行', () => {
    const { db } = setup([fm('a', NOW - 100), fm('b', NOW - 90)]);
    writeAiResults(db, [{ activityId: 'a', error: 'x' }, { activityId: 'b', hasSpeech: true }], NOW);
    assert.equal(resetAiErrors(db), 1);
    assert.deepEqual(
      (db.prepare('SELECT activity_id FROM activity_ai').all() as { activity_id: string }[]).map((r) => r.activity_id),
      ['b'],
    );
  });
});

describe('selectAiByIds', () => {
  it('人工判定压过 AI，并标出来', () => {
    const { db } = setup([fm('a', NOW - 100), fm('b', NOW - 90)]);
    writeAiResults(db, [{ activityId: 'a', hasSpeech: false }, { activityId: 'b', hasSpeech: true, category: 'qso' }], NOW);
    setVerdicts(db, ['a'], false, NOW);
    setVerdicts(db, ['b'], true, NOW);
    const m = selectAiByIds(db, ['a', 'b']);
    assert.equal(m.get('a')!.meaningless, false);
    assert.equal(m.get('a')!.verdict, 'keep');
    assert.equal(m.get('b')!.meaningless, true);
    assert.equal(m.get('b')!.verdict, 'meaningless');
  });

  it('只有判定没有识别结果也生效', () => {
    const { db } = setup([fm('a', NOW - 100)]);
    setVerdicts(db, ['a'], true, NOW);
    assert.deepEqual(selectAiByIds(db, ['a']).get('a'), { meaningless: true, verdict: 'meaningless' });
  });

  it('什么都没有的 id 不在里面，超过一块的 id 列表也读得全', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => fm(`x${i}`, NOW - 5000 + i));
    const { db } = setup(rows);
    writeAiResults(db, rows.map((r) => ({ activityId: r.id, hasSpeech: true })), NOW);
    const m = selectAiByIds(db, [...rows.map((r) => r.id), 'ghost']);
    assert.equal(m.size, 1000);
    assert.equal(m.has('ghost'), false);
  });
});

describe('selectMeaninglessSeeds', () => {
  it('生效判定是无意义的发射才是种子：判定改回去的不是，只有判定的是', () => {
    const { db } = setup([fm('a', NOW - 100), fm('b', NOW - 90), fm('c', NOW - 80), fm('d', NOW - 70)]);
    writeAiResults(
      db,
      [
        { activityId: 'a', hasSpeech: false },
        { activityId: 'b', hasSpeech: false },
        { activityId: 'c', hasSpeech: true, category: 'qso' },
      ],
      NOW,
    );
    setVerdicts(db, ['b'], false, NOW);
    setVerdicts(db, ['d'], true, NOW);
    const ids = selectMeaninglessSeeds(db, 0, 1).map((a) => a.id).sort();
    assert.deepEqual(ids, ['a', 'd']);
  });

  it('保留期之前的不要', () => {
    const { db } = setup([fm('old', NOW - 100_000), fm('new', NOW - 100)]);
    writeAiResults(db, [{ activityId: 'old', hasSpeech: false }, { activityId: 'new', hasSpeech: false }], NOW);
    assert.deepEqual(selectMeaninglessSeeds(db, NOW - 1000, 1).map((a) => a.id), ['new']);
  });
});

describe('selectTodo', () => {
  it('没有结果的 sdr-fm 录音，新的在前，数字侧的不要', () => {
    const { db, dir } = setup([
      fm('old', NOW - 300),
      fm('new', NOW - 100),
      { ...fm('bm', NOW - 50), origin: 'brandmeister', talkgroup: 91 },
    ]);
    assert.deepEqual(todoIds(db, dir, steps()), ['new', 'old']);
  });

  it('limit 截断，item 带上 mine 和 channel', () => {
    const { db, dir } = setup([fm('a', NOW - 300, { mine: true }), fm('b', NOW - 100)]);
    const items = selectTodo(db, { steps: steps(), sinceStartAt: 0, now: NOW, recordingsDir: dir, limit: 1 });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.id, 'b');
    const all = selectTodo(db, { steps: steps(), sinceStartAt: 0, now: NOW, recordingsDir: dir, limit: 5 });
    assert.deepEqual(all.at(-1), { id: 'a', startAt: NOW - 300, durationS: 3, mine: true, channel: '438.975 直频' });
  });

  it('录音文件不在的不要，超出保留期的不要', () => {
    const { db } = setup([fm('a', NOW - 100), fm('b', NOW - 90), fm('old', NOW - 10_000)]);
    // b 的 wav 不在；old 有 wav 但出了保留期
    const dir = mkdtempSync(join(tmpdir(), 'openheard-ai-'));
    writeFileSync(join(dir, 'a.wav'), 'x');
    writeFileSync(join(dir, 'old.wav'), 'x');
    const ids = selectTodo(db, { steps: steps(), sinceStartAt: NOW - 1000, now: NOW, recordingsDir: dir, limit: 10 }).map((i) => i.id);
    assert.deepEqual(ids, ['a']);
  });

  it('候选行很多、前面一大批没有录音时，照样凑得够 limit', () => {
    const rows = Array.from({ length: 130 }, (_, i) => fm(`r${String(i).padStart(3, '0')}`, NOW - 5000 + i));
    const { db } = setup(rows);
    const dir = mkdtempSync(join(tmpdir(), 'openheard-ai-'));
    // 最旧的 3 条有录音，新的 127 条没有
    for (const r of rows.slice(0, 3)) writeFileSync(join(dir, `${r.id}.wav`), 'x');
    assert.deepEqual(todoIds(db, dir, steps(), 10), ['r002', 'r001', 'r000']);
  });

  it('出错且 attempts 不到 3、距上次超过一小时才重试', () => {
    const { db, dir } = setup([fm('fresh', NOW - 500), fm('wait', NOW - 400), fm('spent', NOW - 300)]);
    writeAiResults(db, [{ activityId: 'fresh', error: 'x' }], NOW - 7200);
    writeAiResults(db, [{ activityId: 'wait', error: 'x' }], NOW - 600);
    writeAiResults(db, [{ activityId: 'spent', error: 'x' }], NOW - 20000);
    writeAiResults(db, [{ activityId: 'spent', error: 'x' }], NOW - 15000);
    writeAiResults(db, [{ activityId: 'spent', error: 'x' }], NOW - 10000);
    assert.equal((db.prepare("SELECT attempts FROM activity_ai WHERE activity_id = 'spent'").get() as { attempts: number }).attempts, 3);
    assert.deepEqual(todoIds(db, dir, steps()), ['fresh']);
  });

  it('错误清掉后用满了次数的行重新排队', () => {
    const { db, dir } = setup([fm('spent', NOW - 300)]);
    for (const at of [NOW - 20000, NOW - 15000, NOW - 10000]) writeAiResults(db, [{ activityId: 'spent', error: 'x' }], at);
    assert.deepEqual(todoIds(db, dir, steps()), []);
    resetAiErrors(db);
    assert.deepEqual(todoIds(db, dir, steps()), ['spent']);
  });

  it('识别开着：有人声但还没识别的要做，没人声的和已识别的不要', () => {
    const { db, dir } = setup([fm('vadonly', NOW - 500), fm('nospeech', NOW - 400), fm('done', NOW - 300)]);
    writeAiResults(db, [{ activityId: 'vadonly', hasSpeech: true }], NOW);
    writeAiResults(db, [{ activityId: 'nospeech', hasSpeech: false }], NOW);
    writeAiResults(db, [{ activityId: 'done', hasSpeech: true, transcript: '你好', asrModel: 'w' }], NOW);
    assert.deepEqual(todoIds(db, dir, steps('vad', 'asr')), ['vadonly']);
    assert.deepEqual(todoIds(db, dir, steps()), []);
  });

  it('提取开着：有转写没提取的要做，并带上 hasSpeech 和 transcript', () => {
    const { db, dir } = setup([fm('t', NOW - 500), fm('empty', NOW - 400), fm('full', NOW - 300)]);
    writeAiResults(db, [{ activityId: 't', hasSpeech: true, transcript: '你好', asrModel: 'w' }], NOW);
    writeAiResults(db, [{ activityId: 'empty', hasSpeech: true, transcript: '', asrModel: 'w' }], NOW);
    writeAiResults(db, [{ activityId: 'full', hasSpeech: true, transcript: '好', asrModel: 'w', textModel: 'q', category: 'qso' }], NOW);
    const items = selectTodo(db, { steps: steps('asr', 'text'), sinceStartAt: 0, now: NOW, recordingsDir: dir, limit: 10 });
    assert.deepEqual(items.map((i) => i.id), ['t']);
    assert.equal(items[0]!.hasSpeech, true);
    assert.equal(items[0]!.transcript, '你好');
    // 提取关着就不要
    assert.deepEqual(todoIds(db, dir, steps('asr')), []);
  });

  it('从没识别过的行不带 hasSpeech 和 transcript', () => {
    const { db, dir } = setup([fm('n', NOW - 500)]);
    const [item] = selectTodo(db, { steps: steps('asr', 'text'), sinceStartAt: 0, now: NOW, recordingsDir: dir, limit: 10 });
    assert.equal('transcript' in item!, false);
    assert.equal('hasSpeech' in item!, false);
  });

  it('出错的行即使没识别过，也不绕过重试上限', () => {
    const { db, dir } = setup([fm('x', NOW - 500)]);
    for (const at of [NOW - 20000, NOW - 15000, NOW - 10000]) writeAiResults(db, [{ activityId: 'x', error: 'e' }], at);
    assert.deepEqual(todoIds(db, dir, steps('asr', 'text')), []);
  });

  it('countTodo 和 selectTodo 用同一套条件', () => {
    const { db, dir } = setup([fm('a', NOW - 500), fm('b', NOW - 400), fm('c', NOW - 300)]);
    writeAiResults(db, [{ activityId: 'a', hasSpeech: false }], NOW);
    assert.equal(countTodo(db, { steps: steps(), sinceStartAt: 0, now: NOW, recordingsDir: dir }), 2);
  });
});

describe('aiStats', () => {
  it('最近 24 小时做完的，和最近一次错误', () => {
    const { db } = setup([fm('a', NOW - 500), fm('b', NOW - 400), fm('c', NOW - 300)]);
    writeAiResults(db, [{ activityId: 'a', hasSpeech: true }], NOW - 100);
    writeAiResults(db, [{ activityId: 'b', hasSpeech: true }], NOW - 90_000);
    writeAiResults(db, [{ activityId: 'c', error: '坏了' }], NOW - 50);
    const s = aiStats(db, NOW);
    assert.equal(s.doneLast24h, 1);
    assert.deepEqual(s.lastError, { at: NOW - 50, message: '坏了' });
  });
});
