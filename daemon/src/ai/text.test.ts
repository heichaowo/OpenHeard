import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { TextConfig } from '../config.ts';
import { ItemError, WorkerError } from './errors.ts';
import { aiConfig, fakeServer, json, makeEnv } from './fakes.ts';
import type { FakeServer } from './fakes.ts';
import { extract, parseExtraction, SYSTEM_PROMPT, userMessage } from './text.ts';

describe('读提取的回复', () => {
  it('合法的回复：category 和字段', () => {
    const r = parseExtraction('{"category":"qso","call":"BH1ABC","calledCall":"BG0CG","rst":"59","qth":"成都"}');
    assert.equal(r.category, 'qso');
    assert.deepEqual(r.fields, { call: 'BH1ABC', calledCall: 'BG0CG', rst: '59', qth: '成都' });
  });

  // 空对象和 noise 要分得开：前者是没提取到字段，后者是没有话
  it('只有噪声：category 是 noise，没有字段', () => {
    const r = parseExtraction('{"category":"noise"}');
    assert.deepEqual(r, { category: 'noise', fields: {} });
  });

  it('没有合法的 category：字段留着，category 不设', () => {
    assert.deepEqual(parseExtraction('{"call":"BH1ABC"}'), { category: undefined, fields: { call: 'BH1ABC' } });
    assert.equal(parseExtraction('{"category":"QSO","call":"BH1ABC"}').category, undefined);
    assert.equal(parseExtraction('{"category":"QSO","call":"BH1ABC"}').fields.call, 'BH1ABC');
  });

  it('不认识的键、空串、非字符串的值丢掉，数字转成字符串', () => {
    const r = parseExtraction('{"category":"qso","call":" BH1ABC ","qth":"","device":null,"foo":"x","rst":59,"height":30}');
    assert.deepEqual(r.fields, { call: 'BH1ABC', rst: '59', height: '30' });
  });

  it('功率只有数字时补 W', () => {
    assert.equal(parseExtraction('{"category":"qso","power":5}').fields.power, '5W');
    assert.equal(parseExtraction('{"category":"qso","power":"7.5"}').fields.power, '7.5W');
    assert.equal(parseExtraction('{"category":"qso","power":"5W"}').fields.power, '5W');
  });

  it('不是 JSON、不是对象：这一条的错', () => {
    for (const bad of ['', 'qso', '[1]', '"x"', 'null', '{"category":']) {
      assert.throws(() => parseExtraction(bad), ItemError, bad);
    }
  });
});

describe('提示词', () => {
  // DeepSeek 和通义的 json_object 模式要求提示里有这个词
  it('系统提示里有 JSON 这个词，要求 category 一定有，噪声返回 noise', () => {
    assert.match(SYSTEM_PROMPT, /JSON/);
    assert.match(SYSTEM_PROMPT, /\{"category":"noise"\}/);
    assert.match(SYSTEM_PROMPT, /不要返回空对象/);
  });

  it('用户消息说明谁在说、在哪个信道', () => {
    assert.match(userMessage('收到', true, '438.500'), /说话人：本台自己/);
    assert.match(userMessage('收到', false, '438.500'), /说话人：别的电台/);
    assert.match(userMessage('收到', false, '438.500'), /信道：438.500/);
    assert.doesNotMatch(userMessage('收到', false, undefined), /信道/);
    assert.match(userMessage('收到', false, undefined), /转写：收到/);
  });
});

describe('extract（假云端）', () => {
  let server: FakeServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const cfgFor = async (reply: (res: Parameters<Parameters<typeof fakeServer>[0]>[1]) => void, extra: Partial<TextConfig> = {}) => {
    await server?.close();
    server = await fakeServer((_call, res) => reply(res));
    return { ...aiConfig(makeEnv()).text, baseUrl: `${server.url}/v1/`, ...extra };
  };
  const ok = (content: string) => (res: Parameters<Parameters<typeof fakeServer>[0]>[1]) =>
    json(res, 200, { choices: [{ message: { content } }] });

  it('请求体：temperature 0、max_tokens 512、json_object，key 走 Bearer', async () => {
    const cfg = await cfgFor(ok('{"category":"qso","call":"BH1ABC"}'));
    const r = await extract(cfg, { transcript: '我是 BH1ABC', mine: false, channel: '438.500' });

    assert.equal(r.fields.call, 'BH1ABC');
    const call = server!.calls[0]!;
    assert.equal(call.path, '/v1/chat/completions');
    assert.equal(call.headers.authorization, 'Bearer sk-test');
    const body = call.body as Record<string, unknown> & { messages: { role: string; content: string }[] };
    assert.equal(body.model, 'test-model');
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 512);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages[0]!.role, 'system');
    assert.equal(body.messages[1]!.content, userMessage('我是 BH1ABC', false, '438.500'));
  });

  // 厂商各自的开关全靠它，代码里不认厂商
  it('extraBody 最后合并，同名的键盖过默认值', async () => {
    const cfg = await cfgFor(ok('{"category":"noise"}'), {
      extraBody: { thinking: { type: 'disabled' }, max_completion_tokens: 512, max_tokens: 256 },
    });
    await extract(cfg, { transcript: 'x', mine: true });
    const body = server!.calls[0]!.body as Record<string, unknown>;
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_completion_tokens, 512);
    assert.equal(body.max_tokens, 256);
  });

  it('回复不是 JSON、content 是空的：这一条的错', async () => {
    await assert.rejects(extract(await cfgFor(ok('好的，结果如下')), { transcript: 'x', mine: false }), ItemError);
    await assert.rejects(extract(await cfgFor(ok('')), { transcript: 'x', mine: false }), ItemError);
    await assert.rejects(
      extract(await cfgFor((res) => json(res, 200, { choices: [{ message: { content: null } }] })), {
        transcript: 'x',
        mine: false,
      }),
      ItemError,
    );
  });

  // 状态码分两类。400/413/422 是这份输入的问题，其余是环境
  it('400、413、422 是这一条的错', async () => {
    for (const status of [400, 413, 422]) {
      const cfg = await cfgFor((res) => json(res, status, { error: 'bad' }));
      await assert.rejects(extract(cfg, { transcript: 'x', mine: false }), ItemError, String(status));
    }
  });

  it('401、403、404、429、500、503 是环境的问题，429 带着 Retry-After', async () => {
    for (const status of [401, 403, 404, 429, 500, 503]) {
      const cfg = await cfgFor((res) => json(res, status, {}, { 'retry-after': '7' }));
      await assert.rejects(
        extract(cfg, { transcript: 'x', mine: false }),
        (e: unknown) => e instanceof WorkerError && e.retryAfterS === 7,
        String(status),
      );
    }
  });

  it('连不上是环境的问题', async () => {
    const cfg = { ...aiConfig(makeEnv()).text, baseUrl: 'http://127.0.0.1:9/v1' };
    await assert.rejects(extract(cfg, { transcript: 'x', mine: false }), WorkerError);
  });
});
