import { parseArgs } from 'node:util';
import { fetchHistory } from './brandmeister.ts';
import type { Rule } from './brandmeister.ts';
import { normalise } from './normalise.ts';

const { values } = parseArgs({
  options: {
    query: { type: 'string' },
    amount: { type: 'string', default: '200' },
    'dry-run': { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
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

if (!values.query) {
  console.error('用法: node src/index.ts --once --dry-run --query dst:91 [--amount 200]');
  process.exit(2);
}

let rule: Rule;
try {
  rule = parseQuery(values.query);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

const amount = Number(values.amount);
const result = await fetchHistory([rule], { amount });

const parsed = result.rows.map((r) => normalise(r)).filter((a) => a !== undefined);
const starts = parsed.map((a) => a.startAt);
const span = starts.length > 0 ? Math.max(...starts) - Math.min(...starts) : 0;

if (values['dry-run']) {
  for (const a of parsed.slice(0, 5)) console.log(JSON.stringify(a));
  if (parsed.length > 5) console.log(`… 还有 ${parsed.length - 5} 行`);
}

console.log(
  JSON.stringify({
    query: values.query,
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
