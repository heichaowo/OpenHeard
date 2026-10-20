import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { VadConfig } from '../config.ts';
import { ItemError, WorkerError } from './errors.ts';
import { aiConfig, loggedCalls, makeEnv, writeWav } from './fakes.ts';
import { detectSpeech, parseVad } from './vad.ts';

// 格式来自上游 speech.cpp，在真机上还没验过。假二进制和这里的样本打的是同一个格式。
const TWO = `Detected 2 speech segments:
Speech segment 0: start = 10.00, end = 150.00
Speech segment 1: start = 180.00, end = 250.00
`;

describe('读 VAD 的输出', () => {
  it('时间是百分之一秒，加起来换算成秒', () => {
    assert.equal(parseVad(TWO, 3).speechS, (140 + 70) / 100);
  });

  it('一段都没有：0 秒，不是错', () => {
    assert.equal(parseVad('Detected 0 speech segments:\n', 3).speechS, 0);
  });

  // 解析不了就判没人声，整批录音会被藏进无意义，再也不会重新处理
  it('没有 Detected 那一行：报错，不当成没人声', () => {
    assert.throws(() => parseVad('start: 0 end: 1\n', 3), ItemError);
    assert.throws(() => parseVad('', 3), ItemError);
  });

  it('声明的段数和读到的行数对不上：报错', () => {
    const short = 'Detected 2 speech segments:\nSpeech segment 0: start = 10.00, end = 150.00\n';
    assert.throws(() => parseVad(short, 3), /说有 2 段，实际读到 1 行/);
    const extra = `${TWO}Speech segment 2: start = 260.00, end = 300.00\n`;
    assert.throws(() => parseVad(extra, 3), ItemError);
  });

  // 如果输出其实是秒，除以 100 会把有话的录音全判成没人声
  it('时间值连录音有多长都没到：多半是秒，报错', () => {
    const seconds = 'Detected 1 speech segments:\nSpeech segment 0: start = 0.50, end = 2.40\n';
    assert.throws(() => parseVad(seconds, 3), /时间单位对不上/);
    // 同样的数字，录音很长时是合理的百分之一秒
    assert.equal(parseVad('Detected 1 speech segments:\nSpeech segment 0: start = 100.00, end = 400.00\n', 3).speechS, 3);
  });

  it('不知道录音多长时不查单位', () => {
    const seconds = 'Detected 1 speech segments:\nSpeech segment 0: start = 0.50, end = 2.40\n';
    assert.equal(parseVad(seconds, undefined).speechS, 0.019);
  });

  it('日志里的杂行不影响读取', () => {
    const noisy = `whisper_vad_init: loading\n${TWO}done\n`;
    assert.equal(parseVad(noisy, 3).speechS, 2.1);
  });
});

describe('detectSpeech（假二进制）', () => {
  const cfgOf = (env: ReturnType<typeof makeEnv>): VadConfig => aiConfig(env).vad;

  it('参数是 -vm 模型 -f 录音 -vt 阈值 -np', async () => {
    const env = makeEnv();
    writeWav(env, 'fm-1');
    const cfg = cfgOf(env);
    assert.equal(await detectSpeech(cfg, join(env.recordings, 'fm-1.wav'), 3), true);
    assert.deepEqual(loggedCalls(env), [
      `vad -vm ${cfg.modelPath} -f ${join(env.recordings, 'fm-1.wav')} -vt 0.5 -np`,
    ]);
  });

  it('没有人声、不到 0.3 秒都是 false', async () => {
    const env = makeEnv();
    writeWav(env, 'fm-silent');
    writeWav(env, 'fm-short');
    assert.equal(await detectSpeech(cfgOf(env), join(env.recordings, 'fm-silent.wav'), 3), false);
    assert.equal(await detectSpeech(cfgOf(env), join(env.recordings, 'fm-short.wav'), 3), false);
  });

  it('非零退出和对不上的输出是这一条的错', async () => {
    const env = makeEnv();
    writeWav(env, 'fm-fail');
    writeWav(env, 'fm-bad');
    await assert.rejects(detectSpeech(cfgOf(env), join(env.recordings, 'fm-fail.wav'), 3), ItemError);
    await assert.rejects(detectSpeech(cfgOf(env), join(env.recordings, 'fm-bad.wav'), 3), ItemError);
  });

  it('二进制不在是环境的问题', async () => {
    const env = makeEnv();
    writeWav(env, 'fm-1');
    const cfg = { ...cfgOf(env), binPath: join(env.dir, 'nope') };
    await assert.rejects(detectSpeech(cfg, join(env.recordings, 'fm-1.wav'), 3), WorkerError);
  });
});
