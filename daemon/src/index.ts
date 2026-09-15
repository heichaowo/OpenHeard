import { parseArgs } from 'node:util';
import { fetchHistory } from './brandmeister.ts';
import type { Rule } from './brandmeister.ts';
import { watchAnalog } from './analog.ts';
import { loadConfig } from './config.ts';
import { Ingest } from './ingest.ts';
import { normalise } from './normalise.ts';
import { start } from './runner.ts';

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

if (values.analog) {
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
  const { dmrId, queries, apiUrl, ingestToken, spoolDir } = result.config;
  console.log(`openheard-daemon 起来了，${queries.length} 条查询，推给 ${apiUrl}`);
  start(queries, dmrId, new Ingest(apiUrl, ingestToken, spoolDir));
}
