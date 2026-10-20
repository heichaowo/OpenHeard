import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import type { TextConfig } from '../config.ts';
import { aiConfig, freePort, makeEnv, until } from './fakes.ts';
import type { Env } from './fakes.ts';
import { LlamaServer, sameLlama } from './llama.ts';
import { WorkerError } from './errors.ts';

const TIMING = { healthTimeoutMs: 4000, pollMs: 20, graceMs: 300 };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let live: LlamaServer[] = [];
let strays: Server[] = [];
afterEach(async () => {
  mock.restoreAll();
  await Promise.all(live.map((l) => l.stop()));
  live = [];
  await Promise.all(strays.map((s) => new Promise((r) => s.close(r))));
  strays = [];
});

/** 假 llama-server 的行为写在它的「模型文件」里。 */
async function setup(behavior: Record<string, unknown> = {}, over: Partial<TextConfig> = {}) {
  const env: Env = makeEnv();
  const model = join(env.models, 'llama.gguf');
  const log = join(env.dir, 'llama.log');
  writeFileSync(log, '');
  writeFileSync(model, JSON.stringify({ log, reply: '{"category":"noise"}', ...behavior }));
  const cfg: TextConfig = {
    ...aiConfig(env).text,
    provider: 'local',
    modelPath: model,
    port: await freePort(),
    idleUnloadS: 77,
    ...over,
  };
  const server = new LlamaServer(cfg, TIMING);
  live.push(server);
  const lines = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { env, cfg, server, lines };
}

describe('LlamaServer', () => {
  it('参数：本机回环、单槽、不留提示缓存、闲了卸模型', async () => {
    const { cfg, server, lines } = await setup();
    assert.equal(await server.ensure(), `http://127.0.0.1:${cfg.port}`);
    assert.deepEqual(lines()[0].argv, [
      '-m', cfg.modelPath,
      '--host', '127.0.0.1',
      '--port', String(cfg.port),
      '-c', '4096',
      '-np', '1',
      '-cram', '0',
      '--no-webui',
      '--sleep-idle-seconds', '77',
    ]);
  });

  it('起好之后再要不会多起一个', async () => {
    const { server, lines } = await setup();
    await Promise.all([server.ensure(), server.ensure()]);
    await server.ensure();
    assert.equal(lines().length, 1);
  });

  it('健康检查要等：/health 先回 503，好了才算', async () => {
    const { server } = await setup({ healthDelayMs: 300 });
    const t = Date.now();
    await server.ensure();
    assert.ok(Date.now() - t >= 250);
  });

  // 上一次的实例还占着端口时它的 /health 会答 200，而我们自己这个起不来
  it('端口上已经有别的实例在答：不起，也不把它当成自己的', async () => {
    const { cfg, server, lines } = await setup();
    const stray = createServer((_q, r) => r.writeHead(200).end('{"status":"ok"}'));
    strays.push(stray);
    await new Promise<void>((r) => stray.listen(cfg.port, '127.0.0.1', r));

    await assert.rejects(server.ensure(), (e: unknown) => e instanceof WorkerError && /已经被别的进程占着/.test(e.message));
    assert.equal(lines().length, 0);
  });

  // 起来就退出（绑不上端口、模型坏了）：原因是子进程最后的几行 stderr
  it('起来就退出：报环境的问题，带上 stderr 最后几行', async () => {
    const { server } = await setup({ mode: 'die' });
    await assert.rejects(server.ensure(), (e: unknown) => e instanceof WorkerError && /bind failed/.test(e.message));
  });

  it('超时还没就绪：杀掉，报环境的问题', async () => {
    const { cfg, lines } = await setup({ healthDelayMs: 60_000 });
    const quick = new LlamaServer(cfg, { ...TIMING, healthTimeoutMs: 400 });
    live.push(quick);
    await assert.rejects(quick.ensure(), (e: unknown) => e instanceof WorkerError && /没就绪/.test(e.message));
    // 子进程被杀掉了，不留在后面占端口
    await until(() => !alive(lines()[0].pid));
  });

  it('起不来（没有这个文件）：环境的问题，不等满 90 秒', async () => {
    const { cfg } = await setup();
    const missing = new LlamaServer({ ...cfg, binPath: '/nonexistent/llama-server' }, TIMING);
    live.push(missing);
    const t = Date.now();
    await assert.rejects(missing.ensure(), WorkerError);
    assert.ok(Date.now() - t < 2000);
  });

  // 管道没人读，子进程写满之后就卡在写日志上。只留最后 20 行，退出时记进日志
  it('stderr 一直有人读，只留最后 20 行，退出时记进日志', async () => {
    const { server } = await setup({ stderrLines: 500 });
    const logged: string[] = [];
    mock.method(console, 'error', (...a: unknown[]) => logged.push(a.join(' ')));
    await server.ensure();
    await server.stop();
    await until(() => logged.some((l) => l.includes('llama-server 退出了')));

    const line = logged.find((l) => l.includes('llama-server 退出了'))!;
    assert.match(line, /log line 499/);
    assert.match(line, /log line 480/);
    assert.doesNotMatch(line, /log line 479\b/);
  });

  it('stop() 在子进程真的退出之后才 resolve，之后再要不会重新起', async () => {
    const { server, lines } = await setup();
    await server.ensure();
    const pid = lines()[0].pid as number;
    await server.stop();
    assert.equal(alive(pid), false);
    await assert.rejects(server.ensure(), WorkerError);
  });

  it('SIGTERM 不退，宽限期过了发 SIGKILL', async () => {
    const { server, lines } = await setup({ mode: 'ignore-term' });
    await server.ensure();
    const pid = lines()[0].pid as number;
    const t = Date.now();
    await server.stop();
    assert.ok(Date.now() - t >= 250, '宽限期内没有发 SIGKILL');
    assert.equal(alive(pid), false);
  });

  it('restart() 之后再要，起一个新的', async () => {
    const { server, lines } = await setup();
    await server.ensure();
    server.restart();
    // 旧的还在退出，新的要换一个端口以外的办法避开它：等它真的没了
    await until(() => !alive(lines()[0].pid));
    await server.ensure();
    assert.equal(lines().length, 2);
    assert.notEqual(lines()[0].pid, lines()[1].pid);
  });

  it('kill() 当场杀掉', async () => {
    const { server, lines } = await setup();
    await server.ensure();
    const pid = lines()[0].pid as number;
    server.kill();
    await until(() => !alive(pid));
  });
});

describe('提取的设置变没变', () => {
  const base = aiConfig(makeEnv()).text;
  it('程序、模型、端口、闲置时间任一个变了就要换', () => {
    assert.equal(sameLlama(base, { ...base }), true);
    assert.equal(sameLlama(base, { ...base, apiKey: 'other', extraBody: { a: 1 }, baseUrl: 'x' }), true);
    for (const change of [{ binPath: 'a' }, { modelPath: 'a' }, { port: 1 }, { idleUnloadS: 1 }]) {
      assert.equal(sameLlama(base, { ...base, ...change }), false, JSON.stringify(change));
    }
  });
});
