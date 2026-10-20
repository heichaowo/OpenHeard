import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { AsrConfig } from '../config.ts';
import { asrModelName, transcribe } from './asr.ts';
import { ItemError, WorkerError } from './errors.ts';
import { aiConfig, fakeServer, json, loggedCalls, makeEnv, writeWav } from './fakes.ts';
import type { FakeServer } from './fakes.ts';

describe('本机识别（假 whisper-cli）', () => {
  it('参数是 -m 模型 -l 语言 --prompt 提示词 -nt -np -f 录音', async () => {
    const env = makeEnv();
    writeWav(env, 'fm-1', '收到，73');
    const cfg = aiConfig(env).asr;
    const wav = join(env.recordings, 'fm-1.wav');

    assert.equal(await transcribe(cfg, wav), '收到，73');
    assert.deepEqual(loggedCalls(env), [`cli -m ${cfg.modelPath} -l zh --prompt 以下是普通话的句子。 -nt -np -f ${wav}`]);
  });

  it('提示词是空的就不带 --prompt', async () => {
    const env = makeEnv();
    writeWav(env, 'fm-1', 'CQ TEST');
    await transcribe({ ...aiConfig(env).asr, prompt: '' }, join(env.recordings, 'fm-1.wav'));
    assert.doesNotMatch(loggedCalls(env)[0]!, /--prompt/);
  });

  it('几段拼成一段', async () => {
    const env = makeEnv();
    writeWav(env, 'fm-1', '第一句。\n第二句。');
    assert.equal(await transcribe(aiConfig(env).asr, join(env.recordings, 'fm-1.wav')), '第一句。 第二句。');
  });

  it('子进程在这个文件上失败：这一条的错', async () => {
    const env = makeEnv();
    writeWav(env, 'fm-1', '', { fail: '' });
    await assert.rejects(transcribe(aiConfig(env).asr, join(env.recordings, 'fm-1.wav')), ItemError);
  });

  it('二进制没有：环境的问题', async () => {
    const env = makeEnv();
    writeWav(env, 'fm-1', 'x');
    const cfg = { ...aiConfig(env).asr, binPath: join(env.dir, 'nope') };
    await assert.rejects(transcribe(cfg, join(env.recordings, 'fm-1.wav')), WorkerError);
  });

  it('模型名取文件名，云端取配置里的 model', () => {
    const env = makeEnv();
    assert.equal(asrModelName(aiConfig(env).asr), 'whisper.bin');
    assert.equal(asrModelName({ ...aiConfig(env).asr, provider: 'chat-audio', model: 'mimo-v2.5-asr' }), 'mimo-v2.5-asr');
  });
});

describe('云端识别', () => {
  let server: FakeServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const setup = async (provider: AsrConfig['provider'], reply: Parameters<typeof fakeServer>[0], extra: Partial<AsrConfig> = {}) => {
    const env = makeEnv();
    writeWav(env, 'fm-1');
    await server?.close();
    server = await fakeServer(reply);
    const cfg: AsrConfig = {
      ...aiConfig(env).asr,
      provider,
      baseUrl: `${server.url}/v1`,
      model: 'm-asr',
      apiKey: 'sk-asr',
      ...extra,
    };
    return { cfg, wav: join(env.recordings, 'fm-1.wav') };
  };

  it('openai-transcriptions：multipart 带 file、model、language、prompt、response_format', async () => {
    const { cfg, wav } = await setup('openai-transcriptions', (_c, res) => json(res, 200, { text: '收到' }), {
      extraBody: { temperature: 0, hotwords: ['BG0CG'] },
    });
    assert.equal(await transcribe(cfg, wav), '收到');

    const call = server!.calls[0]!;
    assert.equal(call.path, '/v1/audio/transcriptions');
    assert.equal(call.headers.authorization, 'Bearer sk-asr');
    assert.match(call.headers['content-type']!, /^multipart\/form-data/);
    const raw = call.rawBody;
    for (const [name, value] of [
      ['model', 'm-asr'],
      ['language', 'zh'],
      ['prompt', '以下是普通话的句子。'],
      ['response_format', 'json'],
      // extraBody 最后合并：标量是文本，对象写成 JSON
      ['temperature', '0'],
      ['hotwords', '["BG0CG"]'],
    ] as const) {
      assert.match(raw, new RegExp(`name="${name}"\\r\\n\\r\\n${value.replace(/[[\]]/g, '\\$&')}\\r\\n`), name);
    }
    assert.match(raw, /name="file"; filename="fm-1\.wav"/);
  });

  it('openai-transcriptions：提示词是空的就不带 prompt', async () => {
    const { cfg, wav } = await setup('openai-transcriptions', (_c, res) => json(res, 200, { text: 'x' }), { prompt: '' });
    await transcribe(cfg, wav);
    assert.doesNotMatch(server!.calls[0]!.rawBody, /name="prompt"/);
  });

  it('chat-audio：input_audio 里是 wav 的 data URL，语言走 asr_options，extraBody 最后合并', async () => {
    const { cfg, wav } = await setup(
      'chat-audio',
      (_c, res) => json(res, 200, { choices: [{ message: { content: '收到了' } }] }),
      { extraBody: { stream: false } },
    );
    assert.equal(await transcribe(cfg, wav), '收到了');

    const call = server!.calls[0]!;
    assert.equal(call.path, '/v1/chat/completions');
    assert.equal(call.headers.authorization, 'Bearer sk-asr');
    const body = call.body as {
      model: string;
      messages: { role: string; content: { type: string; input_audio: { data: string } }[] }[];
      asr_options: unknown;
      stream: boolean;
    };
    assert.equal(body.model, 'm-asr');
    assert.equal(body.messages[0]!.role, 'user');
    const part = body.messages[0]!.content[0]!;
    assert.equal(part.type, 'input_audio');
    assert.equal(part.input_audio.data, `data:audio/wav;base64,${Buffer.from('RIFF....WAVEfmt ').toString('base64')}`);
    assert.deepEqual(body.asr_options, { language: 'zh' });
    assert.equal(body.stream, false);
  });

  it('chat-audio：回应里没有文字是这一条的错', async () => {
    const { cfg, wav } = await setup('chat-audio', (_c, res) => json(res, 200, { choices: [] }));
    await assert.rejects(transcribe(cfg, wav), ItemError);
  });

  it('400、413、422 是这一条的错，401、429、500 是环境的问题', async () => {
    for (const status of [400, 413, 422]) {
      const { cfg, wav } = await setup('chat-audio', (_c, res) => json(res, status, {}));
      await assert.rejects(transcribe(cfg, wav), ItemError, String(status));
    }
    for (const status of [401, 429, 500]) {
      const { cfg, wav } = await setup('openai-transcriptions', (_c, res) => json(res, status, {}, { 'retry-after': '3' }));
      await assert.rejects(
        transcribe(cfg, wav),
        (e: unknown) => e instanceof WorkerError && e.retryAfterS === 3,
        String(status),
      );
    }
  });

  it('录音读不了：这一条的错，不是环境的问题', async () => {
    const { cfg } = await setup('chat-audio', (_c, res) => json(res, 200, {}));
    await assert.rejects(transcribe(cfg, '/nonexistent/fm-x.wav'), ItemError);
  });
});
