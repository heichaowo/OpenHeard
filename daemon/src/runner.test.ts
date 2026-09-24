import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import type { AnalogConfig } from './config.ts';
import type { Ingest } from './ingest.ts';
import { startAnalog } from './runner.ts';

/**
 * 在 PATH 最前面放一个假的 rtl_fm。每次被拉起就往计数文件里记一行，
 * 第一次立刻退出，模拟 USB 掉了，后面几次一直挂着。
 */
function fakeRtlFm(): { starts: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-rtl-'));
  const count = join(dir, 'starts');
  writeFileSync(count, '');
  const bin = join(dir, 'rtl_fm');
  writeFileSync(
    bin,
    `#!/bin/sh
echo x >> "${count}"
[ "$(wc -l < "${count}")" -eq 1 ] && exit 1
exec sleep 30
`,
  );
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return { starts: () => readFileSync(count, 'utf8').split('\n').filter(Boolean).length };
}

const cfg = (freqMhz: number): AnalogConfig => ({
  freqMhz,
  channel: `${freqMhz}`,
  gainDb: 32.8,
  openMarginDb: 12,
  closeMarginDb: 7,
  recordingsDir: mkdtempSync(join(tmpdir(), 'openheard-rec-')),
});

/** 定时器是假的，只能靠 setImmediate 轮询真实的子进程事件。 */
async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('等不到');
    await new Promise((r) => setImmediate(r));
  }
}

describe('startAnalog', () => {
  // rtl_fm 掉了，排上 5 秒后重开。这 5 秒里界面改了设置，重调自己开了一份。
  // 排着的那次还在的话，到点再开一份，两个进程抢一个接收机。
  it('重调时撤掉排着的重开，不多开一份', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const rtl = fakeRtlFm();
    let restarts = 0;
    const ingest = {
      push: async () => ({ sent: true, replayed: 0 }),
      radio: async (s: { restarts?: number }) => {
        restarts = Math.max(restarts, s.restarts ?? 0);
      },
    } as unknown as Ingest;

    const handle = startAnalog(cfg(438.5), ingest);
    try {
      await until(() => restarts === 1);
      handle.retune(cfg(439.525));
      await until(() => rtl.starts() === 2);

      mock.timers.tick(10_000);
      // 多开的那一份要真的起一个子进程才数得到，给它一点真实时间。
      const end = Date.now() + 500;
      await until(() => Date.now() > end);

      assert.equal(rtl.starts(), 2);
    } finally {
      handle.stop();
      mock.timers.reset();
    }
  });

  it('重调多少次都不往进程上多挂 SIGTERM 监听', () => {
    fakeRtlFm();
    const before = process.listenerCount('SIGTERM');
    const ingest = { push: async () => ({}), radio: async () => undefined } as unknown as Ingest;
    const handle = startAnalog(cfg(438.5), ingest);
    try {
      for (let i = 0; i < 12; i++) handle.retune(cfg(438.5 + i * 0.0125));
      assert.equal(process.listenerCount('SIGTERM'), before);
    } finally {
      handle.stop();
    }
  });
});
