import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import type { AiConfig } from '../config.ts';
import { AiApi } from './api.ts';
import { runChild } from './child.ts';
import { aiConfig, fakeApi, fakeServer, freePort, json, loggedCalls, makeEnv, todoItem, until, writeWav } from './fakes.ts';
import type { Env, FakeServer } from './fakes.ts';
import { preflight, startAi, Stats, stepsOf } from './worker.ts';
import type { AiHandle, AiTiming } from './worker.ts';

const FAST: Partial<AiTiming> = {
  idleMs: 30,
  recheckMs: 40,
  backoffMinMs: 40,
  backoffMaxMs: 160,
  statusMs: 60_000,
  statsMs: 3_600_000,
  llama: { healthTimeoutMs: 4000, pollMs: 20, graceMs: 300 },
};

const REPLY = '{"category":"qso","call":"BH1ABC","calledCall":"BG0CG","rst":"59","qth":"成都"}';

/** 本机提取：模型文件里写假 llama-server 的行为，请求和启动参数记在 log 里。 */
async function localText(env: Env, behavior: Record<string, unknown> = {}) {
  const log = join(env.dir, 'llama.log');
  writeFileSync(log, '');
  const modelPath = join(env.models, 'llama.gguf');
  writeFileSync(modelPath, JSON.stringify({ log, reply: REPLY, ...behavior }));
  const text = {
    ...aiConfig(env).text,
    provider: 'local' as const,
    modelPath,
    binPath: env.llamaBin,
    port: await freePort(),
  };
  const lines = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv?: string[]; pid: number; url?: string });
  return { text, lines };
}

type Api = Awaited<ReturnType<typeof fakeApi>>;
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  mock.restoreAll();
  for (const c of closers.splice(0)) await c();
});

/** 起一个假 api、一个假云端文字模型和一个 worker。 */
async function setup(
  over: (env: Env, text: FakeServer) => Partial<AiConfig> = () => ({}),
  reply: (calls: number) => { status: number; body: unknown; headers?: Record<string, string> } = () => ({
    status: 200,
    body: { choices: [{ message: { content: REPLY } }] },
  }),
  timing: Partial<AiTiming> = {},
) {
  const env = makeEnv();
  const api: Api = await fakeApi();
  const stamps: number[] = [];
  const text = await fakeServer((_call, res) => {
    stamps.push(Date.now());
    const r = reply(stamps.length);
    json(res, r.status, r.body, r.headers);
  });
  closers.push(() => api.close(), () => text.close());
  const base = aiConfig(env);
  const cfg: AiConfig = { ...base, text: { ...base.text, baseUrl: `${text.url}/v1` }, ...over(env, text) };
  let ai: AiHandle | undefined;
  const start = (c: AiConfig = cfg) => {
    ai = startAi(c, new AiApi(api.url, 'tok'), { timing: { ...FAST, ...timing } });
    closers.push(() => ai!.stop());
    return ai;
  };
  return { env, api, text, stamps, cfg, start, ai: () => ai! };
}

describe('做一条录音', () => {
  it('人声判断、识别、提取，结果一次推上去；todo 带着开着的步骤', async () => {
    const t = await setup();
    writeWav(t.env, 'fm-1', '我是 BH1ABC 呼叫 BG0CG，信号 59，在成都');
    t.api.state.todo = [todoItem('fm-1', { mine: false })];
    t.start();
    await until(() => t.api.state.posts.length === 1);

    assert.deepEqual(t.api.state.posts[0], {
      activityId: 'fm-1',
      hasSpeech: true,
      transcript: '我是 BH1ABC 呼叫 BG0CG，信号 59，在成都',
      category: 'qso',
      fields: { call: 'BH1ABC', calledCall: 'BG0CG', rst: '59', qth: '成都' },
      asrModel: 'whisper.bin',
      textModel: 'test-model',
    });
    const todo = new URL(t.api.todoCalls()[0]!.path, 'http://x').searchParams;
    assert.equal(todo.get('limit'), '10');
    assert.equal(todo.get('steps'), 'vad,asr,text');
    // 先 VAD 再识别
    assert.deepEqual(
      loggedCalls(t.env).map((l) => l.split(' ')[0]),
      ['vad', 'cli'],
    );
    // 提取请求里带着谁在说和信道
    const body = t.text.calls[0]!.body as { messages: { content: string }[] };
    assert.match(body.messages[1]!.content, /别的电台/);
    assert.match(body.messages[1]!.content, /438\.500/);
  });

  it('没有人声：只推 hasSpeech:false，不去识别', async () => {
    const t = await setup();
    writeWav(t.env, 'fm-silent', 'x');
    t.api.state.todo = [todoItem('fm-silent')];
    t.start();
    await until(() => t.api.state.posts.length === 1);

    assert.deepEqual(t.api.state.posts[0], { activityId: 'fm-silent', hasSpeech: false });
    assert.deepEqual(loggedCalls(t.env).map((l) => l.split(' ')[0]), ['vad']);
    assert.equal(t.text.calls.length, 0);
  });

  // 原始文字照存，下一步不再提取
  it('转写只剩字幕署名：hasSpeech:false，原始文字照存，不提取', async () => {
    const t = await setup();
    writeWav(t.env, 'fm-1', '(字幕製作:貝爾)');
    t.api.state.todo = [todoItem('fm-1')];
    t.start();
    await until(() => t.api.state.posts.length === 1);

    assert.deepEqual(t.api.state.posts[0], {
      activityId: 'fm-1',
      hasSpeech: false,
      transcript: '(字幕製作:貝爾)',
      asrModel: 'whisper.bin',
    });
    assert.equal(t.text.calls.length, 0);
  });

  it('转写是提示词的回声：同样判没有人声', async () => {
    const t = await setup();
    writeWav(t.env, 'fm-1', '这句话是普通话的句子。');
    t.api.state.todo = [todoItem('fm-1')];
    t.start();
    await until(() => t.api.state.posts.length === 1);
    assert.equal(t.api.state.posts[0]!.hasSpeech, false);
  });

  it('带着转写回来的只补提取：不过人声判断也不识别，过滤照样做', async () => {
    const t = await setup();
    t.api.state.todo = [todoItem('fm-1', { hasSpeech: true, transcript: '我是 BH1ABC (字幕君:是)' })];
    t.start();
    await until(() => t.api.state.posts.length === 1);

    assert.deepEqual(loggedCalls(t.env), []);
    const post = t.api.state.posts[0]!;
    assert.equal(post.category, 'qso');
    assert.equal(post.textModel, 'test-model');
    assert.equal(post.asrModel, undefined);
    assert.equal(post.transcript, '我是 BH1ABC (字幕君:是)');
    // 送去提取的是剔掉署名之后的
    const body = t.text.calls[0]!.body as { messages: { content: string }[] };
    assert.match(body.messages[1]!.content, /转写：我是 BH1ABC$/);
  });

  it('带着转写回来、过滤后什么都不剩：补一个 hasSpeech:false，不会一直被要回来', async () => {
    const t = await setup();
    t.api.state.todo = [todoItem('fm-1', { hasSpeech: true, transcript: '(字幕製作:貝爾)' })];
    t.start();
    await until(() => t.api.state.posts.length === 1);
    assert.equal(t.api.state.posts[0]!.hasSpeech, false);
  });

  it('以前判过有人声、识别还没做：不重新过人声判断', async () => {
    const t = await setup();
    writeWav(t.env, 'fm-1', '收到');
    t.api.state.todo = [todoItem('fm-1', { hasSpeech: true })];
    t.start();
    await until(() => t.api.state.posts.length === 1);
    assert.deepEqual(loggedCalls(t.env).map((l) => l.split(' ')[0]), ['cli']);
  });

  it('只开人声判断：推 hasSpeech，steps 只有 vad', async () => {
    const t = await setup((env) => ({
      asr: { ...aiConfig(env).asr, provider: 'off' },
      text: { ...aiConfig(env).text, provider: 'off' },
    }));
    writeWav(t.env, 'fm-1');
    t.api.state.todo = [todoItem('fm-1')];
    t.start();
    await until(() => t.api.state.posts.length === 1);
    assert.deepEqual(t.api.state.posts[0], { activityId: 'fm-1', hasSpeech: true });
    assert.equal(new URL(t.api.todoCalls()[0]!.path, 'http://x').searchParams.get('steps'), 'vad');
  });

  it('人声判断关着：直接识别，hasSpeech 不填；只开识别时不提取', async () => {
    const t = await setup((env) => ({
      vad: { ...aiConfig(env).vad, provider: 'off' },
      text: { ...aiConfig(env).text, provider: 'off' },
    }));
    writeWav(t.env, 'fm-1', '收到，73');
    t.api.state.todo = [todoItem('fm-1')];
    t.start();
    await until(() => t.api.state.posts.length === 1);
    assert.deepEqual(t.api.state.posts[0], {
      activityId: 'fm-1',
      transcript: '收到，73',
      asrModel: 'whisper.bin',
    });
    assert.equal(new URL(t.api.todoCalls()[0]!.path, 'http://x').searchParams.get('steps'), 'asr');
  });

  it('本机的 llama-server：第一次用才起，请求打到它的 /v1/chat/completions', async () => {
    const env = makeEnv();
    const local = await localText(env);
    const t = await setup(() => ({ recordingsDir: env.recordings, vad: aiConfig(env).vad, asr: aiConfig(env).asr, text: local.text }));
    writeWav(env, 'fm-1', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1')];
    const ai = t.start();
    assert.deepEqual(local.lines(), []);
    await until(() => t.api.state.posts.length === 1);

    assert.equal(t.api.state.posts[0]!.textModel, 'llama.gguf');
    const [spawned, request] = local.lines();
    assert.equal(request!.url, '/v1/chat/completions');
    await ai.stop();
    assert.throws(() => process.kill(spawned!.pid, 0), /ESRCH/);
  });
});

describe('两类错误', () => {
  // 一次配置失误不能把整批积压的重试次数用光
  it('环境的问题（401）：不推 error，条目留着，状态报不正常，修好之后接着做', async () => {
    let code = 401;
    const t = await setup(undefined, () =>
      code === 200 ? { status: 200, body: { choices: [{ message: { content: REPLY } }] } } : { status: code, body: {} },
    );
    writeWav(t.env, 'fm-1', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1')];
    t.start();
    await until(() => t.stamps.length >= 2);

    assert.equal(t.api.state.posts.length, 0);
    assert.equal(t.api.state.todo.length, 1);
    await until(() => t.api.state.statuses.some((s) => !s.ok));
    assert.match(t.api.state.statuses.find((s) => !s.ok)!.message, /401/);

    code = 200;
    await until(() => t.api.state.posts.length === 1);
    assert.equal(t.api.state.posts[0]!.error, undefined);
    assert.equal(t.api.state.posts[0]!.category, 'qso');
    await until(() => t.api.state.statuses.at(-1)!.ok);
  });

  it('403、404、429、500 同样是环境的问题', async () => {
    for (const status of [403, 404, 429, 500]) {
      const t = await setup(undefined, () => ({ status, body: {} }));
      writeWav(t.env, 'fm-1', '收到');
      t.api.state.todo = [todoItem('fm-1')];
      const ai = t.start();
      await until(() => t.stamps.length >= 1);
      await ai.stop();
      assert.equal(t.api.state.posts.length, 0, String(status));
      for (const c of closers.splice(0)) await c();
    }
  });

  it('退避从最小值开始翻倍，封顶', async () => {
    const t = await setup(undefined, () => ({ status: 500, body: {} }));
    writeWav(t.env, 'fm-1', '收到');
    t.api.state.todo = [todoItem('fm-1')];
    t.start();
    await until(() => t.stamps.length >= 5, 8000);

    const gaps = t.stamps.slice(1).map((s, i) => s - t.stamps[i]!);
    // 40、80、160、160（封顶）。留点余量给调度
    assert.ok(gaps[0]! >= 35 && gaps[0]! < 120, `第一段 ${gaps[0]}`);
    assert.ok(gaps[1]! >= 70, `第二段 ${gaps[1]}`);
    assert.ok(gaps[2]! >= 140, `第三段 ${gaps[2]}`);
    assert.ok(gaps[3]! >= 140 && gaps[3]! < 400, `封顶之后 ${gaps[3]}`);
  });

  it('尊重 Retry-After', async () => {
    const t = await setup(undefined, () => ({ status: 429, body: {}, headers: { 'retry-after': '1' } }));
    writeWav(t.env, 'fm-1', '收到');
    t.api.state.todo = [todoItem('fm-1')];
    t.start();
    await until(() => t.stamps.length >= 2, 6000);
    assert.ok(t.stamps[1]! - t.stamps[0]! >= 950, `间隔 ${t.stamps[1]! - t.stamps[0]!}`);
  });

  it('这一条的问题（400）：推 error，带着已经做完的部分，接着做下一条', async () => {
    const t = await setup(undefined, (n) =>
      n === 1
        ? { status: 400, body: { error: 'bad' } }
        : { status: 200, body: { choices: [{ message: { content: REPLY } }] } },
    );
    writeWav(t.env, 'fm-1', '收到收到');
    writeWav(t.env, 'fm-2', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1'), todoItem('fm-2')];
    t.start();
    await until(() => t.api.state.posts.length === 2);

    const [bad, good] = t.api.state.posts;
    assert.equal(bad!.activityId, 'fm-1');
    assert.match(bad!.error!, /400/);
    // 人声和识别已经做完的，错误行里也带着，重试时只补提取
    assert.equal(bad!.hasSpeech, true);
    assert.equal(bad!.transcript, '收到收到');
    assert.equal(bad!.asrModel, 'whisper.bin');
    assert.equal(good!.activityId, 'fm-2');
    assert.equal(good!.error, undefined);
  });

  it('同一步连着两条失败：当成环境的问题，两条都不推 error', async () => {
    const t = await setup(undefined, () => ({ status: 400, body: {} }));
    for (const id of ['fm-1', 'fm-2', 'fm-3']) writeWav(t.env, id, '收到');
    t.api.state.todo = [todoItem('fm-1'), todoItem('fm-2'), todoItem('fm-3')];
    t.start();
    await until(() => t.api.state.statuses.some((s) => !s.ok));

    assert.equal(t.api.state.posts.length, 0);
    assert.match(t.api.state.statuses.find((s) => !s.ok)!.message, /连着两条/);
    assert.equal(t.api.state.todo.length, 3);
  });

  it('不同步骤各失败一条不算：两条都推 error', async () => {
    const t = await setup(undefined, () => ({ status: 400, body: {} }));
    // fm-fail 死在人声判断，fm-2 死在提取
    writeWav(t.env, 'fm-fail', '收到');
    writeWav(t.env, 'fm-2', '收到');
    t.api.state.todo = [todoItem('fm-fail'), todoItem('fm-2')];
    t.start();
    await until(() => t.api.state.posts.length === 2);
    assert.ok(t.api.state.posts.every((p) => p.error !== undefined));
  });

  // 两条坏的挨在一起，环境没问题：不能让它们挡住后面的整个队列。
  it('相邻两条坏录音、环境正常：先退避，换别的条目验过环境之后，两条都记 error，队列往前走', async () => {
    const t = await setup();
    for (const id of ['fm-fail-a', 'fm-fail-b']) writeWav(t.env, id, '收到');
    for (const id of ['fm-g1', 'fm-g2', 'fm-g3']) writeWav(t.env, id, '我是 BH1ABC');
    t.api.state.todo = ['fm-fail-a', 'fm-fail-b', 'fm-g1', 'fm-g2', 'fm-g3'].map((id) => todoItem(id));
    t.start();
    await until(() => t.api.state.posts.length === 5);

    const by = new Map(t.api.state.posts.map((p) => [p.activityId, p]));
    assert.ok(by.get('fm-fail-a')!.error);
    assert.ok(by.get('fm-fail-b')!.error);
    for (const id of ['fm-g1', 'fm-g2', 'fm-g3']) assert.equal(by.get(id)!.error, undefined, id);
    assert.equal(t.api.state.todo.length, 0);
    // 暂停那一次的状态里点了两条的名，运维页上才知道是哪两条
    const paused = t.api.state.statuses.find((s) => !s.ok)!;
    assert.match(paused.message, /fm-fail-a/);
    assert.match(paused.message, /fm-fail-b/);
    await until(() => t.api.state.statuses.at(-1)!.ok);
  });

  it('环境真的坏了：换别的条目一试也失败，什么都不推，退避翻倍，状态里点名', async () => {
    const t = await setup();
    const ids = ['fm-fail-1', 'fm-fail-2', 'fm-fail-3', 'fm-fail-4'];
    for (const id of ids) writeWav(t.env, id, '收到');
    t.api.state.todo = ids.map((id) => todoItem(id));
    t.start();
    await until(() => t.api.todoCalls().length >= 4, 8000);

    assert.equal(t.api.state.posts.length, 0);
    assert.equal(t.api.state.todo.length, 4);
    const msgs = t.api.state.statuses.filter((s) => !s.ok).map((s) => s.message);
    assert.match(msgs[0]!, /fm-fail-1.*fm-fail-2|fm-fail-2.*fm-fail-1/);
    // 第二轮是拿别的条目对照，对照的那条也点名
    assert.ok(msgs.some((m) => /fm-fail-3/.test(m)), msgs.join('\n'));
  });

  // 线上一次来一条：跨批次也要认出「连着两条」。
  it('一次一条的批次：第一条记 error，第二条在同一步失败就升级成环境的问题，不记', async () => {
    const t = await setup();
    for (const id of ['fm-fail-1', 'fm-fail-2']) writeWav(t.env, id, '收到');
    t.api.state.todo = [todoItem('fm-fail-1')];
    t.start();
    await until(() => t.api.state.posts.length === 1);
    assert.equal(t.api.state.posts[0]!.activityId, 'fm-fail-1');
    assert.ok(t.api.state.posts[0]!.error);
    assert.ok(t.api.state.statuses.every((s) => s.ok));

    t.api.state.todo = [todoItem('fm-fail-2')];
    await until(() => t.api.state.statuses.some((s) => !s.ok));
    const paused = t.api.state.statuses.find((s) => !s.ok)!;
    assert.match(paused.message, /fm-fail-1/);
    assert.match(paused.message, /fm-fail-2/);
    assert.equal(t.api.state.posts.length, 1);
  });

  it('隔了一条成功的，不算连着：两条失败都记 error', async () => {
    const t = await setup();
    for (const id of ['fm-fail-1', 'fm-fail-2']) writeWav(t.env, id, '收到');
    writeWav(t.env, 'fm-ok', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-fail-1')];
    t.start();
    await until(() => t.api.state.posts.length === 1);
    t.api.state.todo = [todoItem('fm-ok')];
    await until(() => t.api.state.posts.length === 2);
    t.api.state.todo = [todoItem('fm-fail-2')];
    await until(() => t.api.state.posts.length === 3);
    assert.ok(t.api.state.posts[2]!.error);
    assert.ok(t.api.state.statuses.every((s) => s.ok));
  });

  it('同一条自己重试时又失败，不当成「连着两条」', async () => {
    const t = await setup();
    writeWav(t.env, 'fm-fail-1', '收到');
    t.api.state.todo = [todoItem('fm-fail-1')];
    t.start();
    await until(() => t.api.state.posts.length === 1);
    // api 过了一小时又把它给回来
    t.api.state.todo = [todoItem('fm-fail-1')];
    await until(() => t.api.state.posts.length === 2);
    assert.ok(t.api.state.statuses.every((s) => s.ok));
  });

  it('api 推送失败是环境的问题：退避后重做', async () => {
    const t = await setup();
    writeWav(t.env, 'fm-1', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1')];
    t.api.state.failPost = 503;
    t.start();
    await until(() => t.api.calls.filter((c) => c.path === '/api/ingest/ai').length >= 1);
    t.api.state.failPost = 0;
    await until(() => t.api.state.posts.length === 1);
  });

  it('todo 取不到：退避，不退出', async () => {
    const t = await setup();
    t.api.state.failTodo = 500;
    t.start();
    await until(() => t.api.todoCalls().length >= 2);
    t.api.state.failTodo = 0;
    writeWav(t.env, 'fm-1', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1')];
    await until(() => t.api.state.posts.length === 1);
  });

  it('做不动的条目不让循环空转：todo 一直返回它，请求也按空闲间隔来', async () => {
    // 带着转写回来，但提取关着：没有事可做，不推
    const t = await setup(
      (env) => ({ text: { ...aiConfig(env).text, provider: 'off' } }),
      undefined,
      { idleMs: 100 },
    );
    t.api.state.todo = [todoItem('fm-1', { hasSpeech: true, transcript: '收到' })];
    t.start();
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(t.api.state.posts.length, 0);
    assert.ok(t.api.todoCalls().length <= 6, `请求了 ${t.api.todoCalls().length} 次`);
  });
});

describe('批次进行中录音被删了', () => {
  // 收听页上删对话，wav 随之被删。同一条对话的几次发射在 todo 里挨着，
  // 不能因为这个就把 worker 当成环境出了问题。
  it('删掉的条目不记 error、不暂停，后面的接着做', async () => {
    const t = await setup();
    // whisper-cli 睡一会儿，给删文件留出时间；.txt 一并删掉它才会失败退出
    writeWav(t.env, 'fm-1', '收到', { sleep: '0.4' });
    writeWav(t.env, 'fm-2', '收到', { sleep: '0.4' });
    writeWav(t.env, 'fm-3', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1'), todoItem('fm-2'), todoItem('fm-3')];
    t.start();
    await until(() => loggedCalls(t.env).some((l) => l.startsWith('cli') && l.includes('fm-1')));
    for (const id of ['fm-1', 'fm-2']) {
      rmSync(join(t.env.recordings, `${id}.wav`));
      rmSync(join(t.env.recordings, `${id}.wav.txt`));
    }
    await until(() => t.api.state.posts.length === 1);

    assert.equal(t.api.state.posts[0]!.activityId, 'fm-3');
    assert.equal(t.api.state.posts[0]!.error, undefined);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t.api.state.posts.length, 1);
    assert.ok(t.api.state.statuses.every((s) => s.ok), JSON.stringify(t.api.state.statuses));
  });

  it('文件还在的失败照旧记 error', async () => {
    const t = await setup();
    writeWav(t.env, 'fm-fail-1', '收到');
    t.api.state.todo = [todoItem('fm-fail-1')];
    t.start();
    await until(() => t.api.state.posts.length === 1);
    assert.ok(t.api.state.posts[0]!.error);
  });
});

describe('预检', () => {
  it('开着的本机步骤缺文件：不去要活，报状态，只记一次日志', async () => {
    const t = await setup();
    const model = join(t.env.models, 'late.bin');
    t.cfg.asr.modelPath = model;
    const logged: string[] = [];
    mock.method(console, 'error', (...a: unknown[]) => logged.push(a.join(' ')));
    writeWav(t.env, 'fm-1', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1')];
    t.start();
    await until(() => t.api.state.statuses.length >= 1);
    await new Promise((r) => setTimeout(r, 250));

    assert.equal(t.api.todoCalls().length, 0);
    assert.equal(t.api.state.posts.length, 0);
    assert.match(t.api.state.statuses[0]!.message, /缺文件/);
    assert.match(t.api.state.statuses[0]!.message, /late\.bin/);
    assert.equal(logged.filter((l) => l.includes('缺文件')).length, 1);
  });

  it('模型后来下好了：不用重载，下一轮预检就接着做', async () => {
    const t = await setup();
    const model = join(t.env.models, 'late.bin');
    t.cfg.asr.modelPath = model;
    mock.method(console, 'error', () => undefined);
    writeWav(t.env, 'fm-1', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1')];
    t.start();
    await until(() => t.api.state.statuses.length >= 1);
    assert.equal(t.api.todoCalls().length, 0);

    writeFileSync(model, 'x');
    await until(() => t.api.state.posts.length === 1);
    assert.equal(t.api.state.posts[0]!.category, 'qso');
  });

  it('preflight：每个开着的本机步骤的程序和模型都查；裸名字去 PATH 里找', async () => {
    const env = makeEnv();
    const cfg = aiConfig(env);
    assert.deepEqual(await preflight(cfg), []);

    const bad: AiConfig = {
      ...cfg,
      vad: { ...cfg.vad, binPath: 'definitely-not-installed-xyz' },
      asr: { ...cfg.asr, modelPath: '/nonexistent/m.bin' },
      text: { ...cfg.text, provider: 'local', binPath: '/nonexistent/llama-server', modelPath: '/nonexistent/q.gguf' },
    };
    const missing = await preflight(bad);
    assert.equal(missing.length, 4);
    assert.ok(missing.some((m) => m.includes('definitely-not-installed-xyz')));

    // 关着的步骤不查，云端的也不查
    const off: AiConfig = { ...bad, vad: { ...bad.vad, provider: 'off' }, text: { ...bad.text, provider: 'openai-chat' } };
    assert.equal((await preflight(off)).length, 1);

    const onPath = { ...cfg, vad: { ...cfg.vad, binPath: 'sh' } };
    assert.deepEqual(await preflight(onPath), []);
  });

  it('stepsOf：本机 VAD、识别不是 off、提取不是 off', () => {
    const cfg = aiConfig(makeEnv());
    assert.deepEqual(stepsOf(cfg), ['vad', 'asr', 'text']);
    assert.deepEqual(stepsOf({ ...cfg, vad: { ...cfg.vad, provider: 'off' } }), ['asr', 'text']);
    assert.deepEqual(stepsOf({ ...cfg, asr: { ...cfg.asr, provider: 'chat-audio' } }), ['vad', 'asr', 'text']);
  });
});

describe('叫醒和停下', () => {
  it('wake() 打断空闲的等待：新录音不用等满空闲间隔', async () => {
    const t = await setup(undefined, undefined, { idleMs: 60_000 });
    const ai = t.start();
    await until(() => t.api.todoCalls().length === 1);

    writeWav(t.env, 'fm-1', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1')];
    const started = Date.now();
    ai.wake();
    await until(() => t.api.state.posts.length === 1, 3000);
    assert.ok(Date.now() - started < 3000);
  });

  // todo 回来是空的，而叫醒发生在请求途中：之后的等待必须当场结束，不能把这次叫醒丢了
  it('wake() 在请求 todo 的途中来：回来是空的也不等满空闲间隔', async () => {
    const t = await setup(undefined, undefined, { idleMs: 60_000 });
    t.api.state.todoDelayMs = 300;
    const ai = t.start();
    await until(() => t.api.todoCalls().length === 1);

    writeWav(t.env, 'fm-1', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1')];
    t.api.state.todoDelayMs = 0;
    ai.wake();
    await until(() => t.api.state.posts.length === 1, 3000);
  });

  it('退避的时候 wake() 不打断', async () => {
    const t = await setup(undefined, () => ({ status: 500, body: {} }), { backoffMinMs: 500, backoffMaxMs: 500 });
    writeWav(t.env, 'fm-1', '收到');
    t.api.state.todo = [todoItem('fm-1')];
    const ai = t.start();
    await until(() => t.stamps.length === 1);
    ai.wake();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(t.stamps.length, 1);
    await until(() => t.stamps.length === 2, 3000);
  });

  it('stop() 之后不再要活，也不再推', async () => {
    const t = await setup();
    const ai = t.start();
    await until(() => t.api.todoCalls().length >= 1);
    await ai.stop();
    const n = t.api.todoCalls().length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(t.api.todoCalls().length, n);
  });

  it('stop() 停掉正在跑的子进程，那条录音不推 error', async () => {
    const t = await setup();
    writeWav(t.env, 'fm-1', 'x', { sleep: '5' });
    t.api.state.todo = [todoItem('fm-1')];
    const ai = t.start();
    await until(() => loggedCalls(t.env).some((l) => l.startsWith('cli')));
    await ai.stop();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t.api.state.posts.length, 0);
  });

  it('本机提取超时：杀掉 llama-server，下一次重新起，条目留着', async () => {
    const env = makeEnv();
    const local = await localText(env, { replyDelayMs: 600 });
    const t = await setup(
      () => ({ recordingsDir: env.recordings, vad: aiConfig(env).vad, asr: aiConfig(env).asr, text: local.text }),
      undefined,
      { textTimeoutMs: 250, backoffMinMs: 100, backoffMaxMs: 100 },
    );
    writeWav(env, 'fm-1', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1')];
    t.start();

    await until(() => local.lines().filter((l) => l.argv !== undefined).length >= 2, 8000);
    assert.equal(t.api.state.posts.length, 0);
    assert.equal(t.api.state.todo.length, 1);
  });
});

describe('事件循环', () => {
  // 接收机的样本在这个进程的事件循环里处理。同步地等子进程，管道会满，样本丢掉
  it('假 whisper-cli 跑 1 秒时，50 毫秒的定时器从不晚到超过 100 毫秒', async () => {
    const t = await setup((env) => ({ vad: { ...aiConfig(env).vad, provider: 'off' } }));
    writeWav(t.env, 'fm-warm', 'x');
    // 新写的可执行文件第一次执行，macOS 要扫描半秒。线上的二进制早就扫过了
    await runChild(t.env.cliBin, ['-f', join(t.env.recordings, 'fm-warm.wav')], 10_000);
    writeWav(t.env, 'fm-1', '我是 BH1ABC', { sleep: '1' });
    t.api.state.todo = [todoItem('fm-1')];

    let last = Date.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last - 50);
      last = now;
    }, 50);
    closers.push(() => clearInterval(timer));
    t.start();
    await until(() => t.api.state.posts.length === 1, 10_000);
    clearInterval(timer);

    assert.ok(worst <= 100, `最晚的一次晚了 ${worst} 毫秒`);
  });

  it('daemon/src/ai 里没有同步的子进程和文件调用', () => {
    const dir = new URL('.', import.meta.url).pathname;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== 'fakes.ts')) {
      const code = readFileSync(join(dir, f), 'utf8');
      assert.doesNotMatch(code, /\b(?:exec|execFile|spawn|readFile|writeFile|readdir|stat|access|existsSync|mkdir)Sync\b/, f);
    }
  });
});

describe('小结日志', () => {
  it('Stats：处理、无人声、无意义、出错、平均用时', () => {
    const s = new Stats();
    s.add({ activityId: 'a', hasSpeech: false }, 1000);
    s.add({ activityId: 'b', hasSpeech: true, category: 'test' }, 3000);
    s.add({ activityId: 'c', hasSpeech: true, category: 'qso' }, 2000);
    s.add({ activityId: 'd', error: 'x' }, 2000);
    assert.equal(s.line(), '识别小结：处理 3 条，无人声 1，无意义 2，出错 1，平均 2.0 秒/条');
    s.reset();
    assert.equal(s.line(), '识别小结：处理 0 条，无人声 0，无意义 0，出错 0，平均 0.0 秒/条');
  });

  it('worker 每隔一段时间记一行，记完清零', async () => {
    const t = await setup(undefined, undefined, { statsMs: 150 });
    const logged: string[] = [];
    mock.method(console, 'log', (...a: unknown[]) => logged.push(a.join(' ')));
    writeWav(t.env, 'fm-1', '我是 BH1ABC');
    t.api.state.todo = [todoItem('fm-1')];
    t.start();
    await until(() => logged.some((l) => l.startsWith('识别小结：处理 1 条')));
    await until(() => logged.some((l) => l.startsWith('识别小结：处理 0 条')));
  });
});

// 不用别的文件：这里只是确认 AiApi 拿的是 Bearer，不是别的凭据
describe('api 客户端', () => {
  it('带 Bearer，状态走 /api/ingest/ai/status', async () => {
    const api = await fakeApi();
    closers.push(() => api.close());
    const client = new AiApi(api.url, 'tok');
    await client.status(false, '缺文件');
    assert.deepEqual(api.state.statuses, [{ ok: false, message: '缺文件' }]);
    assert.equal(api.calls[0]!.headers.authorization, 'Bearer tok');
    // 错的 token：回 401，客户端不抛（状态报不上去就算了）
    await new AiApi(api.url, 'wrong').status(true, 'x');
    assert.equal(api.state.statuses.length, 1);
  });
});
