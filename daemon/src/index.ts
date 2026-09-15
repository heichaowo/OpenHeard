import { parseArgs } from 'node:util';
import { fetchHistory } from './brandmeister.ts';
import type { Rule } from './brandmeister.ts';
import { readFileSync } from 'node:fs';
import { watchAnalog } from './analog.ts';
import { decodeMdc } from './mdc.ts';
import { loadConfig } from './config.ts';
import { Ingest } from './ingest.ts';
import { normalise } from './normalise.ts';
import { start, startAnalog } from './runner.ts';

const { values } = parseArgs({
  options: {
    query: { type: 'string' },
    amount: { type: 'string', default: '200' },
    'dry-run': { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
    analog: { type: 'string' },
    gain: { type: 'string' },
    recordings: { type: 'string' },
    'rtl-fm': { type: 'string' },
    'unit-id': { type: 'string' },
    'mdc-probe': { type: 'string' },
    config: { type: 'string' },
  },
});

/** `dst:91` 或 `src:4600000`。 */
function parseQuery(spec: string): Rule {
  const [kind, raw] = spec.split(':');
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`查询写错了：${spec}`);
  if (kind === 'dst') return { id: 'DestinationID', operator: 'equal', value };
  if (kind === 'src') return { id: 'SourceID', operator: 'equal', value };
  throw new Error(`不认识的查询类型：${kind}，只有 dst 和 src`);
}

/** 不带配置也能跑一次，用来验证采集这一侧。 */
async function once(spec: string): Promise<void> {
  let rule: Rule;
  try {
    rule = parseQuery(spec);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }

  const result = await fetchHistory([rule], { amount: Number(values.amount) });
  const parsed = result.rows.map((r) => normalise(r)).filter((a) => a !== undefined);
  const starts = parsed.map((a) => a.startAt);
  const span = starts.length > 0 ? Math.max(...starts) - Math.min(...starts) : 0;

  if (values['dry-run']) {
    for (const a of parsed.slice(0, 5)) console.log(JSON.stringify(a));
    if (parsed.length > 5) console.log(`… 还有 ${parsed.length - 5} 行`);
  }

  console.log(
    JSON.stringify({
      query: spec,
      fetched: result.rows.length,
      parsed: parsed.length,
      complete: result.complete,
      ms: result.ms,
      spanSec: span,
      spanHours: Number((span / 3600).toFixed(2)),
      talkgroups: [...new Set(parsed.map((a) => a.talkgroup))].slice(0, 5),
      distinctSourceIds: new Set(parsed.map((a) => a.dmrId)).size,
    }),
  );
}

if (values['mdc-probe']) {
  // 把一个 WAV 过一遍解码器。用来拿真实录音验证。
  const buf = readFileSync(values['mdc-probe']);
  const rate = buf.readUInt32LE(24);
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) >> 1);
  const frames = decodeMdc(pcm, rate);
  console.log(`${values['mdc-probe']}  ${rate} Hz  ${(pcm.length / rate).toFixed(2)} 秒`);
  if (frames.length === 0) console.log('  没有解出 MDC 帧');
  for (const f of frames) {
    const hex = f.unitId.toString(16).toUpperCase().padStart(4, '0');
    console.log(
      `  unitId ${hex} (十进制 ${f.unitId})  op ${f.op.toString(16).padStart(2, '0')}` +
        `  arg ${f.arg.toString(16).padStart(2, '0')}  在 ${(f.atSample / rate).toFixed(3)} 秒`,
    );
  }
} else if (values.analog) {
  // 只守模拟信道，不连 API，用来在真信号上验证判决。
  // 用法: node src/index.ts --analog 438.700 [--gain 32.8]
  const mhz = Number(values.analog);
  if (!Number.isFinite(mhz)) {
    console.error(`频率写错了：${values.analog}`);
    process.exit(2);
  }
  const stop = watchAnalog(
    {
      freqHz: Math.round(mhz * 1e6),
      channel: `${mhz} MHz`,
      gainDb: Number(values.gain ?? '32.8'),
      sampleRate: 24000,
      blockS: 0.05,
      calibrateS: 5,
      openMarginDb: 12,
      closeMarginDb: 7,
      minDurationS: 0.3,
      prerollS: 0.6,
      myUnitId: values['unit-id'] === undefined ? undefined : parseInt(values['unit-id'], 16),
      recordingsDir: values.recordings ?? './recordings',
      rtlFmPath: values['rtl-fm'] ?? 'rtl_fm',
    },
    (a) => console.log(JSON.stringify(a)),
  );
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
} else if (values.once || values.query) {
  if (!values.query) {
    console.error('用法: node src/index.ts --once --dry-run --query dst:91 [--amount 200]');
    process.exit(2);
  }
  await once(values.query);
} else {
  const path = values.config ?? process.env.OPENHEARD_CONFIG ?? './openheard.config.json';
  const result = loadConfig(path);
  if (!result.ok) {
    for (const p of result.problems) console.error(`配置: ${p}`);
    process.exit(2);
  }
  const { dmrId, queries, apiUrl, ingestToken, spoolDir, analog } = result.config;
  const ingest = new Ingest(apiUrl, ingestToken, spoolDir);
  console.log(
    `openheard-daemon 起来了，${queries.length} 条查询` +
      `${analog ? `，守听 ${analog.freqMhz} MHz` : '，没配模拟守听'}，推给 ${apiUrl}`,
  );
  start(queries, dmrId, ingest);
  if (analog) startAnalog(analog, ingest);
}
