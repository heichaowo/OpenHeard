import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.ts';
import { watchConfig } from './reload.ts';
import type { AnalogConfig, Query } from './config.ts';

const base = {
  dmrId: 4616460,
  ingestToken: 'x'.repeat(32),
  analog: { freqMhz: 438.7, channel: '438.700 直频', myUnitId: '6460' },
  queries: [
    {
      key: 'dst:46001',
      rule: { id: 'DestinationID', operator: 'equal', value: 46001 },
      amount: 200,
      intervalS: 900,
    },
  ],
};

/** api 写设置就是这么落盘的：先写临时文件再 rename。 */
function setup(): { path: string; write: (next: unknown) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-reload-'));
  const path = join(dir, 'openheard.config.json');
  writeFileSync(path, JSON.stringify(base, null, 2));
  return {
    path,
    write: (next) => {
      writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2));
      renameSync(`${path}.tmp`, path);
    },
  };
}

/**
 * 等到条件成立，而不是睡一个固定的时长。
 *
 * fs.watch 加上防抖走的是真实时钟，机器忙的时候那一下会晚到，睡死一个
 * 时长就会偶发失败。偶发失败的测试比没有测试更糟。
 */
async function until(ok: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) return;
    await sleep(50);
  }
}

/**
 * 写到看见通知为止。
 *
 * macOS 上 fs.watch 刚挂上的那一刻写进去的改动，机器忙的时候会漏掉，于是整个
 * 测试干等到超时。线上不会这样，界面存设置总在守护进程起来很久之后。同样的
 * 内容再写一遍不会多出一次通知，所以重写不影响「只通知一次」的断言。
 */
async function writeUntil(write: (next: unknown) => void, next: unknown, ok: () => boolean) {
  for (let i = 0; i < 6 && !ok(); i++) {
    write(next);
    await until(ok, 1000);
  }
}

const start = (path: string) => {
  const r = loadConfig(path);
  assert.ok(r.ok);
  const seen: { queries: Query[][]; analog: AnalogConfig[] } = { queries: [], analog: [] };
  const stop = watchConfig(path, r.config, {
    queries: (q) => seen.queries.push(q),
    analog: (a) => seen.analog.push(a),
  });
  return { seen, stop };
};

describe('watchConfig', () => {
  it('频率改了就通知换频', async () => {
    const { path, write } = setup();
    const { seen, stop } = start(path);

    await writeUntil(write, { ...base, analog: { ...base.analog, freqMhz: 145.5 } }, () => seen.analog.length > 0);
    stop();

    assert.equal(seen.analog.length, 1);
    assert.equal(seen.analog[0].freqMhz, 145.5);
    assert.equal(seen.queries.length, 0);
  });

  it('查询改了就通知重开计时器', async () => {
    const { path, write } = setup();
    const { seen, stop } = start(path);

    await writeUntil(
      write,
      {
        ...base,
        queries: [{ ...base.queries[0], key: 'dst:91', rule: { id: 'DestinationID', operator: 'equal', value: 91 } }],
      },
      () => seen.queries.length > 0,
    );
    stop();

    assert.equal(seen.queries.length, 1);
    assert.equal(seen.queries[0][0].key, 'dst:91');
    assert.equal(seen.analog.length, 0);
  });

  it('没实际变化就什么都不做', async () => {
    const { path, write } = setup();
    const { seen, stop } = start(path);

    write({ ...base });
    await sleep(900);
    stop();

    assert.deepEqual([seen.queries.length, seen.analog.length], [0, 0]);
  });

  // 手一抖存了个半截 JSON，不该让采集停摆。这个进程一退，launchd 每 30 秒重来一次。
  it('改坏了就留在原样接着跑', async () => {
    const { path, write } = setup();
    const { seen, stop } = start(path);

    writeFileSync(path, '{ 这不是 JSON');
    await sleep(700);
    await writeUntil(write, { ...base, analog: { ...base.analog, freqMhz: 439.525 } }, () => seen.analog.length > 0);
    stop();

    // 坏的那次没生效，后面改好的那次照常生效
    assert.equal(seen.analog.length, 1);
    assert.equal(seen.analog[0].freqMhz, 439.525);
  });
});
