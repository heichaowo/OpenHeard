// 识别这一块的测试用具：假二进制（shell 脚本）、假 api 和假云端服务。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiConfig } from '../config.ts';
import type { AiResult, TodoItem } from './api.ts';

const here = new URL('.', import.meta.url).pathname;

export interface Env {
  dir: string;
  recordings: string;
  models: string;
  vadBin: string;
  cliBin: string;
  llamaBin: string;
  /** 假二进制把收到的参数一行一份记在这里。 */
  log: string;
}

const script = (dir: string, name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

let bins: { vadBin: string; cliBin: string; llamaBin: string } | undefined;

/**
 * 三个假二进制，整个测试进程只写一次。macOS 对新写的可执行文件第一次执行要扫描
 * 半秒左右，每个测试都重写一遍，一个测试文件就要多等十几秒。
 */
function fakeBins() {
  if (bins) return bins;
  const dir = mkdtempSync(join(tmpdir(), 'openheard-ai-bin-'));
  // 日志写在录音目录的上一级，也就是每个 Env 自己的目录
  const logOf = 'log="$(dirname "$wav")/../calls.log"';
  // 假的 whisper-vad-speech-segments 输出的是 contract 钉死的格式。
  // 文件名里带 silent、short、bad、fail 的各走一条路。
  const vadBin = script(
    dir,
    'whisper-vad-speech-segments',
    `wav=""
a="$*"
while [ $# -gt 0 ]; do case "$1" in -f) wav="$2"; shift;; esac; shift; done
${logOf}
echo "vad $a" >> "$log"
case "$wav" in
  *silent*) echo "Detected 0 speech segments:" ;;
  *short*) echo "Detected 1 speech segments:"; echo "Speech segment 0: start = 10.00, end = 20.00" ;;
  *bad*) echo "start: 0 end: 1" ;;
  *fail*) echo "boom" >&2; exit 3 ;;
  *) echo "Detected 2 speech segments:"; echo "Speech segment 0: start = 10.00, end = 150.00"; echo "Speech segment 1: start = 180.00, end = 250.00" ;;
esac`,
  );
  // 转写写在 <wav>.txt 里。<wav>.sleep 是睡多少秒，<wav>.fail 存在就失败退出。
  const cliBin = script(
    dir,
    'whisper-cli',
    `wav=""
a="$*"
while [ $# -gt 0 ]; do case "$1" in -f) wav="$2"; shift;; esac; shift; done
${logOf}
echo "cli $a" >> "$log"
[ -f "$wav.fail" ] && { echo "decode failed" >&2; exit 1; }
[ -f "$wav.sleep" ] && sleep "$(cat "$wav.sleep")"
cat "$wav.txt"`,
  );
  const llamaBin = script(dir, 'llama-server', `exec "${process.execPath}" "${here}fake-llama.mjs" "$@"`);
  bins = { vadBin, cliBin, llamaBin };
  return bins;
}

export function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-ai-'));
  const recordings = join(dir, 'recordings');
  const models = join(dir, 'models');
  for (const d of [recordings, models]) mkdirSync(d);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(join(models, 'silero.bin'), 'x');
  writeFileSync(join(models, 'whisper.bin'), 'x');
  return { dir, recordings, models, ...fakeBins(), log };
}

/** 一段录音：内容无所谓，假二进制只看文件名和旁边的 .txt。 */
export function writeWav(env: Env, id: string, transcript?: string, extra: Record<string, string> = {}): void {
  const wav = join(env.recordings, `${id}.wav`);
  writeFileSync(wav, 'RIFF....WAVEfmt ');
  if (transcript !== undefined) writeFileSync(`${wav}.txt`, `${transcript}\n`);
  for (const [ext, body] of Object.entries(extra)) writeFileSync(`${wav}.${ext}`, body);
}

export const todoItem = (id: string, extra: Partial<TodoItem> = {}): TodoItem => ({
  id,
  startAt: 1_789_000_000,
  durationS: 3,
  mine: false,
  channel: '438.500',
  ...extra,
});

/** 全本机、三步都开的配置，各测试再按需要改。 */
export function aiConfig(env: Env, over: Partial<AiConfig> = {}): AiConfig {
  return {
    recordingsDir: env.recordings,
    vad: { provider: 'local', binPath: env.vadBin, modelPath: join(env.models, 'silero.bin'), threshold: 0.5 },
    asr: {
      provider: 'local',
      binPath: env.cliBin,
      modelPath: join(env.models, 'whisper.bin'),
      language: 'zh',
      prompt: '以下是普通话的句子。',
      baseUrl: '',
      model: '',
      apiKey: '',
      extraBody: {},
    },
    text: {
      provider: 'openai-chat',
      binPath: env.llamaBin,
      modelPath: join(env.models, 'llama.gguf'),
      port: 8091,
      idleUnloadS: 120,
      baseUrl: '',
      model: 'test-model',
      apiKey: 'sk-test',
      extraBody: {},
    },
    ...over,
  };
}

export interface Call {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  /** JSON 请求体解出来的对象；multipart 留原文。 */
  body: unknown;
  rawBody: string;
}

export interface FakeServer {
  url: string;
  calls: Call[];
  close: () => Promise<void>;
}

type Handler = (call: Call, res: ServerResponse) => void | Promise<void>;

/** 起在随机端口上的假服务。云端提供方和假 api 都用它。 */
export async function fakeServer(handler: Handler): Promise<FakeServer> {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown = rawBody;
      try {
        body = JSON.parse(rawBody);
      } catch {
        // multipart 或者没有请求体
      }
      const call: Call = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body, rawBody };
      calls.push(call);
      void handler(call, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** 假 api：todo 里放什么就返回什么，推上来的结果记下，并把那条从 todo 里拿掉。 */
export async function fakeApi(token = 'tok') {
  const state = {
    todo: [] as TodoItem[],
    posts: [] as AiResult[],
    statuses: [] as { ok: boolean; message: string }[],
    /** 设了就让这个入口回这个状态码。 */
    failTodo: 0,
    failPost: 0,
    /** todo 先按收到请求那一刻的内容定下答案，再等这么久才回。 */
    todoDelayMs: 0,
  };
  const server = await fakeServer(async (call, res) => {
    if (call.headers.authorization !== `Bearer ${token}`) return json(res, 401, {});
    const path = call.path.split('?')[0];
    if (call.method === 'GET' && path === '/api/ingest/ai/todo') {
      if (state.failTodo) return json(res, state.failTodo, {});
      const limit = Number(new URL(call.path, 'http://x').searchParams.get('limit'));
      const items = state.todo.slice(0, limit);
      if (state.todoDelayMs > 0) await sleep(state.todoDelayMs);
      return json(res, 200, { items });
    }
    if (path === '/api/ingest/ai/status') {
      state.statuses.push(call.body as { ok: boolean; message: string });
      res.writeHead(204).end();
      return;
    }
    if (path === '/api/ingest/ai') {
      if (state.failPost) return json(res, state.failPost, {});
      const results = call.body as AiResult[];
      state.posts.push(...results);
      const done = new Set(results.map((r) => r.activityId));
      state.todo = state.todo.filter((i) => !done.has(i.id));
      return json(res, 200, { written: results.length });
    }
    json(res, 404, {});
  });
  return { ...server, state, todoCalls: () => server.calls.filter((c) => c.path.startsWith('/api/ingest/ai/todo')) };
}

/** 一个当下空闲的端口。先占住再放掉，几个测试文件并行跑也不会撞。 */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** 假二进制记下的调用，一行一份。 */
export const loggedCalls = (env: Env) =>
  readFileSync(env.log, 'utf8')
    .split('\n')
    .filter(Boolean);

/** 等到条件成立。固定睡一段时间的测试机器一忙就偶发失败。 */
export async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('等不到');
    await new Promise((r) => setTimeout(r, 10));
  }
}
