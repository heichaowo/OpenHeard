import { watchAnalog } from './analog.ts';
import { fetchHistory } from './brandmeister.ts';
import type { AnalogConfig, Query } from './config.ts';
import { Ingest } from './ingest.ts';
import type { IngestRow } from './ingest.ts';
import { normalise } from './normalise.ts';

const nowS = () => Math.floor(Date.now() / 1000);

/** 一轮都没跑完超过间隔的这么多倍就自杀，让 launchd 重新拉起来。 */
const WATCHDOG_FACTOR = 5;

async function runOnce(q: Query, dmrId: number, ingest: Ingest): Promise<void> {
  const at = nowS();
  const started = Date.now();
  let fetched = 0;
  let parsed = 0;

  try {
    const result = await fetchHistory([q.rule], { amount: q.amount });
    fetched = result.rows.length;

    const rows: IngestRow[] = [];
    for (const row of result.rows) {
      const activity = normalise(row, dmrId);
      if (activity) rows.push({ activity, raw: JSON.stringify(row) });
    }
    parsed = rows.length;

    const { replayed } = await ingest.push(rows, {
      queryKey: q.key,
      at,
      fetched,
      parsed,
      written: 0, // 真正新增多少行由写入端算，这里填不了
      ok: true,
      ms: Date.now() - started,
    });
    if (replayed > 0) console.log(`${q.key} 补发了 ${replayed} 批`);
  } catch (e) {
    await ingest.push([], {
      queryKey: q.key,
      at,
      fetched,
      parsed,
      written: 0,
      ok: false,
      ms: Date.now() - started,
      errorMsg: (e as Error).message,
    });
    console.error(`${q.key} 轮询失败：${(e as Error).message}`);
  }
}

/** rtl_fm 掉了就重开。无人值守时守听停了没人会发现。 */
const RESTART_MS = 5000;

/**
 * 模拟守听。每次静噪开启推一条 activity，顺带记一行 poll_log，
 * 这样运维页上看得出模拟侧还活着。
 */
export function startAnalog(cfg: AnalogConfig, ingest: Ingest): void {
  const spawn = () => {
    const stop = watchAnalog(
      {
        freqHz: Math.round(cfg.freqMhz * 1e6),
        channel: cfg.channel,
        gainDb: cfg.gainDb,
        sampleRate: 24000,
        blockS: 0.05,
        calibrateS: 5,
        openMarginDb: 12,
        closeMarginDb: 7,
        minDurationS: 0.3,
        prerollS: 0.6,
        myUnitId: cfg.unitId === undefined ? undefined : parseInt(cfg.unitId, 16),
        recordingsDir: cfg.recordingsDir,
        rtlFmPath: 'rtl_fm',
      },
      (activity) => {
        const at = nowS();
        void ingest.push(
          [{ activity, raw: JSON.stringify({ source: 'sdr-fm', channel: cfg.channel, at }) }],
          {
            queryKey: `analog:${cfg.channel}`,
            at,
            fetched: 1,
            parsed: 1,
            written: 0,
            ok: true,
            ms: Math.round(activity.durationS * 1000),
          },
        );
      },
      () => {
        console.error(`rtl_fm 停了，${RESTART_MS / 1000} 秒后重开`);
        setTimeout(spawn, RESTART_MS);
      },
    );
    process.on('SIGTERM', stop);
  };
  spawn();
}

/** 每条查询一个计时器。间隔和 amount 按话务组各给各的，没有全局值。 */
export function start(queries: Query[], dmrId: number, ingest: Ingest): void {
  for (const q of queries) {
    let running = false;
    let lastDone = Date.now();

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await runOnce(q, dmrId, ingest);
        lastDone = Date.now();
      } finally {
        running = false;
      }
    };

    void tick();
    setInterval(() => void tick(), q.intervalS * 1000);

    setInterval(() => {
      const stalled = Date.now() - lastDone;
      if (stalled > q.intervalS * WATCHDOG_FACTOR * 1000) {
        // 无人值守时重启比挂死强。
        console.error(`${q.key} 已经 ${Math.round(stalled / 1000)} 秒没跑完一轮，退出让守护重启`);
        process.exit(1);
      }
    }, q.intervalS * 1000);
  }
}
