import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { watchAnalog } from './analog.ts';
import type { AnalogConfig } from './analog.ts';
import type { Activity } from './core.ts';

const FS = 24000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/** 一段合成的 rtl_fm 输出：noise 是没有载波时的宽带噪声，carrier 是载波压住噪声后的话音。 */
function pcm(plan: [kind: 'noise' | 'carrier', seconds: number][]): Buffer {
  const r = rng(7);
  const parts = plan.map(([kind, sec]) => {
    const n = Math.round(sec * FS);
    const out = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const v =
        kind === 'noise' ? r() * 8000 : 4000 * Math.sin((2 * Math.PI * 1000 * i) / FS) + r() * 60;
      out.writeInt16LE(Math.round(v), i * 2);
    }
    return out;
  });
  return Buffer.concat(parts);
}

/** 假的 rtl_fm：把准备好的样点原样吐出来就退出。 */
function fakeRtlFm(audio: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-fm-'));
  const raw = join(dir, 'audio.raw');
  writeFileSync(raw, audio);
  const bin = join(dir, 'rtl_fm');
  writeFileSync(bin, `#!/bin/sh\ncat "${raw}"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const cfg = (rtlFmPath: string, recordingsDir: string): AnalogConfig => ({
  freqHz: 438_500_000,
  channel: '438.500',
  gainDb: 32.8,
  sampleRate: FS,
  blockS: 0.05,
  calibrateS: 0.5,
  openMarginDb: 12,
  closeMarginDb: 7,
  minDurationS: 0.3,
  trackS: 1,
  maxOpenS: 2,
  prerollS: 0.6,
  recordingsDir,
  rtlFmPath,
});

async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('等不到');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('watchAnalog', () => {
  // 以前静噪开着时音频一直 push 进一个 number[]，开 93 分钟就撞上 V8 的数组上限，
  // 整个进程崩掉。现在开到 maxOpenS 强制关，长发射切成几段，录音长度有上限。
  it('长过 maxOpenS 的发射切成几段，录音不丢块也不超长，之后照常认得出下一次', async () => {
    const rec = mkdtempSync(join(tmpdir(), 'openheard-rec-'));
    const bin = fakeRtlFm(
      pcm([
        ['noise', 1],
        ['carrier', 3],
        ['noise', 0.5],
        ['carrier', 1],
        ['noise', 1],
      ]),
    );
    const events: Activity[] = [];
    let exited = false;
    const radio = watchAnalog(
      cfg(bin, rec),
      (a) => events.push(a),
      () => {
        exited = true;
      },
    );
    try {
      await until(() => exited && events.length >= 3);

      assert.deepEqual(
        events.map((e) => e.durationS),
        [2, 1, 1],
      );
      const samples = (a: Activity) => (statSync(join(rec, `${a.id}.wav`)).size - 44) / 2;
      // 第一段：0.6 秒前导加整整 2 秒，强制关掉的那一块也在里面
      assert.equal(samples(events[0]!), FS * 2.6);
      // 第二段紧接着第一段，没有前导
      assert.equal(samples(events[1]!), FS * 1);
      assert.equal(readdirSync(rec).length, 3);
    } finally {
      radio.stop();
    }
  });
});
