import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import type { AiConfig } from '../config.ts';
import { AiApi } from './api.ts';
import { aiConfig, fakeApi, freePort, makeEnv, todoItem, until, writeWav } from './fakes.ts';
import type { Env } from './fakes.ts';
import { AiSwitch } from './switch.ts';

const FAST = { idleMs: 30, recheckMs: 40, backoffMinMs: 40, backoffMaxMs: 80, llama: { healthTimeoutMs: 4000, pollMs: 20, graceMs: 300 } };
const REPLY = '{"category":"qso","call":"BH1ABC"}';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  mock.restoreAll();
  for (const c of closers.splice(0)) await c();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function setup() {
  const env: Env = makeEnv();
  const api = await fakeApi();
  closers.push(() => api.close());
  const log = join(env.dir, 'llama.log');
  writeFileSync(log, '');
  const model = join(env.models, 'llama.gguf');
  writeFileSync(model, JSON.stringify({ log, reply: REPLY }));
  const base = aiConfig(env);
  const cfg: AiConfig = {
    ...base,
    vad: { ...base.vad, provider: 'off' },
    text: { ...base.text, provider: 'local', modelPath: model, binPath: env.llamaBin, port: await freePort() },
  };
  const sw = new AiSwitch(new AiApi(api.url, 'tok'), FAST);
  closers.push(async () => {
    await sw.apply(undefined);
  });
  mock.method(console, 'log', () => undefined);
  mock.method(console, 'error', () => undefined);
  const pids = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.includes('"argv"'))
      .map((l) => JSON.parse(l).pid as number);
  return { env, api, cfg, sw, pids };
}

/** 让 worker 真的用一次 llama-server，它才会被拉起来。 */
async function useLlama(t: Awaited<ReturnType<typeof setup>>, id: string) {
  writeWav(t.env, id, '我是 BH1ABC');
  t.api.state.todo = [todoItem(id)];
  const before = t.api.state.posts.length;
  await until(() => t.api.state.posts.length > before);
}

describe('AiSwitch', () => {
  it('提取的设置没变：llama-server 留给新的 worker，不重新起', async () => {
    const t = await setup();
    await t.sw.apply(t.cfg);
    await useLlama(t, 'fm-1');
    const [pid] = t.pids();
    const first = t.sw.current;

    // 只改识别的语言，提取没动
    await t.sw.apply({ ...t.cfg, asr: { ...t.cfg.asr, language: 'en' } });
    assert.notEqual(t.sw.current, first);
    assert.equal(alive(pid!), true);
    await useLlama(t, 'fm-2');

    assert.deepEqual(t.pids(), [pid]);
  });

  it('提取的设置变了：旧的 llama-server 退干净之后才起新的 worker', async () => {
    const t = await setup();
    await t.sw.apply(t.cfg);
    await useLlama(t, 'fm-1');
    const [oldPid] = t.pids();

    const port = await freePort();
    await t.sw.apply({ ...t.cfg, text: { ...t.cfg.text, port } });
    // apply 返回时旧的已经没了，端口让出来了
    assert.equal(alive(oldPid!), false);
    await useLlama(t, 'fm-2');
    assert.equal(t.pids().length, 2);
    assert.match(readFileSync(join(t.env.dir, 'llama.log'), 'utf8'), new RegExp(`"--port","${port}"`));
  });

  it('关掉：worker 停了，llama-server 退了', async () => {
    const t = await setup();
    await t.sw.apply(t.cfg);
    await useLlama(t, 'fm-1');
    const [pid] = t.pids();

    await t.sw.apply(undefined);
    assert.equal(t.sw.current, undefined);
    assert.equal(alive(pid!), false);
    const n = t.api.todoCalls().length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t.api.todoCalls().length, n);
  });

  it('连着改两次配置：按先后顺序一个个换，不交叉', async () => {
    const t = await setup();
    await t.sw.apply(t.cfg);
    await useLlama(t, 'fm-1');

    const a = t.sw.apply({ ...t.cfg, asr: { ...t.cfg.asr, language: 'en' } });
    const b = t.sw.apply({ ...t.cfg, asr: { ...t.cfg.asr, language: 'ja' } });
    await Promise.all([a, b]);
    assert.equal(t.sw.current?.cfg.asr.language, 'ja');
  });

  it('wake() 送到现在这个 worker', async () => {
    const t = await setup();
    await t.sw.apply(t.cfg);
    await t.sw.apply({ ...t.cfg, asr: { ...t.cfg.asr, language: 'en' } });
    let woke = 0;
    const current = t.sw.current!;
    const wake = current.wake.bind(current);
    (current as { wake: () => void }).wake = () => {
      woke += 1;
      wake();
    };
    t.sw.wake();
    assert.equal(woke, 1);
  });

  it('wake() 和 kill() 在没有 worker 时什么都不做', () => {
    const sw = new AiSwitch(new AiApi('http://127.0.0.1:9', 'tok'));
    sw.wake();
    sw.kill();
  });

  it('kill()：当场杀掉 llama-server，不等', async () => {
    const t = await setup();
    await t.sw.apply(t.cfg);
    await useLlama(t, 'fm-1');
    const [pid] = t.pids();
    t.sw.kill();
    await until(() => !alive(pid!));
  });
});
