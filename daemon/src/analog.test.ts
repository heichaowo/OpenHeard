import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { watchAnalog } from './analog.ts';
import type { AnalogConfig, RadioStatus } from './analog.ts';
import { AUDIO_RATE } from './channelizer.ts';
import { planTuning } from './core.ts';
import type { Activity } from './core.ts';

const RATE = 1_200_000;
const A = 438_500_000;
const B = 438_975_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/**
 * 一段合成的 rtl_sdr 输出。只有 438.500 上有载波，按 plan 一段一段开关，
 * 438.975 一直空着。
 */
function iq(plan: [kind: 'noise' | 'carrier', seconds: number][]): Buffer {
  const tuning = planTuning([A, B]);
  assert.ok(tuning.ok);
  assert.equal(tuning.plan.sampleRate, RATE);
  const offset = tuning.plan.offsetsHz[0]!;
  const r = rng(7);
  const total = plan.reduce((n, [, s]) => n + Math.round(s * RATE), 0);
  const out = Buffer.alloc(total * 2);
  let k = 0;
  for (const [kind, sec] of plan) {
    const n = Math.round(sec * RATE);
    for (let j = 0; j < n; j++, k++) {
      const ph = (2 * Math.PI * offset * k) / RATE + 3 * Math.sin((2 * Math.PI * 1000 * k) / RATE);
      const amp = kind === 'carrier' ? 50 : 0;
      out[2 * k] = Math.max(0, Math.min(255, Math.round(amp * Math.cos(ph) + r() * 20 + 127.5)));
      out[2 * k + 1] = Math.max(0, Math.min(255, Math.round(amp * Math.sin(ph) + r() * 20 + 127.5)));
    }
  }
  return out;
}

/** 假的 rtl_sdr：把准备好的 IQ 原样吐出来就退出。 */
function fakeRtlSdr(data: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-sdr-'));
  const raw = join(dir, 'iq.raw');
  writeFileSync(raw, data);
  const bin = join(dir, 'rtl_sdr');
  writeFileSync(bin, `#!/bin/sh\ncat "${raw}"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const cfg = (rtlSdrPath: string, recordingsDir: string): AnalogConfig => ({
  channels: [
    { freqHz: A, channel: '438.500 中继' },
    { freqHz: B, channel: '438.975' },
  ],
  gainDb: 49.6,
  blockS: 0.05,
  calibrateS: 0.5,
  openMarginDb: 12,
  closeMarginDb: 7,
  minDurationS: 0.3,
  trackS: 1,
  maxOpenS: 2,
  prerollS: 0.6,
  recordingsDir,
  rtlSdrPath,
});

async function until(ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('等不到');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe('watchAnalog', () => {
  // 一支接收机守两个信道：只有有载波的那个出事件，另一个一直静默。
  // 以前静噪开着时音频一直 push 进一个 number[]，开 93 分钟就撞上 V8 的数组上限，
  // 整个进程崩掉。现在开到 maxOpenS 强制关，长发射切成几段，录音长度有上限。
  it('两个信道各判各的，长发射切成几段，录音不超长', async () => {
    const rec = mkdtempSync(join(tmpdir(), 'openheard-rec-'));
    const bin = fakeRtlSdr(
      iq([
        ['noise', 1],
        ['carrier', 3],
        ['noise', 0.5],
        ['carrier', 1],
        ['noise', 1],
      ]),
    );
    const events: Activity[] = [];
    const statuses: RadioStatus[][] = [];
    let exited = false;
    const radio = watchAnalog(
      cfg(bin, rec),
      (a) => events.push(a),
      () => {
        exited = true;
      },
      (s) => statuses.push(s),
    );
    try {
      await until(() => exited && events.length >= 3);

      assert.ok(events.every((e) => e.channel === '438.500 中继' && e.freqMhz === 438.5));
      const d = events.map((e) => e.durationS);
      assert.ok(near(d[0]!, 2, 0.05) && near(d[1]!, 1, 0.1) && near(d[2]!, 1, 0.1), `时长 ${d.join(', ')}`);

      const samples = (a: Activity) => (statSync(join(rec, `${a.id}.wav`)).size - 44) / 2;
      // 第一段：0.6 秒前导加 2 秒，强制关掉的那一块也在里面。录音不超过这个上限。
      assert.ok(near(samples(events[0]!), AUDIO_RATE * 2.6, 1200), `第一段 ${samples(events[0]!)} 个样点`);
      assert.equal(readdirSync(rec).length, 3);

      // 两个信道都报了状态
      assert.ok(statuses.length > 0);
      assert.deepEqual(
        statuses.at(-1)!.map((s) => s.freqMhz),
        [438.5, 438.975],
      );
    } finally {
      radio.stop();
    }
  });

  it('一支接收机收不下的信道表直接报错，不去碰接收机', () => {
    const bad = { ...cfg('/nonexistent', ''), channels: [
      { freqHz: 438_000_000, channel: 'a' },
      { freqHz: 440_000_000, channel: 'b' },
    ] };
    assert.throws(() => watchAnalog(bad, () => undefined), /最多 1.8 MHz/);
  });
});
