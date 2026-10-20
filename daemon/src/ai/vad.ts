import type { VadConfig } from '../config.ts';
import { ensureOk, runChild } from './child.ts';
import { ItemError } from './errors.ts';

/** 加起来不到这么久的话音，算没有人声。 */
const MIN_SPEECH_S = 0.3;
/** 本机 VAD 很快，跑不完就是出了事。 */
const TIMEOUT_MS = 120_000;

const DETECTED = /^Detected (\d+) speech segments:?\s*$/m;
const SEGMENT = /^Speech segment (\d+): start = (-?\d+(?:\.\d+)?), end = (-?\d+(?:\.\d+)?)\s*$/gm;

/**
 * 读 whisper-vad-speech-segments 的输出。
 *
 * 格式来自上游 examples/vad-speech-segments/speech.cpp，还没有在真机上验过
 * （见 docs/deployment.md）：先一行 `Detected N speech segments:`，再 N 行
 * `Speech segment i: start = T0, end = T1`，时间是百分之一秒。对不上就抛错，
 * 绝不当成「没有人声」：解析不了而判没人声，整批录音会全被藏进无意义，
 * 而且再也不会被重新处理。
 */
export function parseVad(output: string, durationS: number | undefined): { speechS: number } {
  const head = DETECTED.exec(output);
  if (head === null) throw new ItemError('vad', 'VAD 输出里没有 Detected 那一行，格式和预期的对不上');
  const declared = Number(head[1]);

  let total = 0;
  let maxEnd = 0;
  let parsed = 0;
  for (const m of output.matchAll(SEGMENT)) {
    const [t0, t1] = [Number(m[2]), Number(m[3])];
    if (!(t1 >= t0)) throw new ItemError('vad', `VAD 的片段时间不对：${m[0]}`);
    total += t1 - t0;
    maxEnd = Math.max(maxEnd, t1);
    parsed += 1;
  }
  if (parsed !== declared) {
    throw new ItemError('vad', `VAD 说有 ${declared} 段，实际读到 ${parsed} 行`);
  }
  // 单位是百分之一秒，最短的话音 25 厘秒起算。读到的最大值还没有录音时长大，
  // 多半输出的其实是秒：按百分之一秒除一遍会把有话的录音全判成没人声。
  if (parsed > 0 && durationS !== undefined && durationS > 0 && maxEnd <= durationS * 1.5 + 1) {
    throw new ItemError('vad', `VAD 的时间单位对不上（最大 ${maxEnd}，录音 ${durationS} 秒），先照部署文档核对格式`);
  }
  return { speechS: total / 100 };
}

/** 有没有人声。 */
export async function detectSpeech(
  cfg: VadConfig,
  wav: string,
  durationS: number | undefined,
): Promise<boolean> {
  const r = await runChild(
    cfg.binPath,
    ['-vm', cfg.modelPath, '-f', wav, '-vt', String(cfg.threshold), '-np'],
    TIMEOUT_MS,
  );
  ensureOk('vad', cfg.binPath, r);
  // Detected 那一行在 stdout 还是 stderr 上没有验过，两边都看。片段行的格式
  // 很具体，日志里的杂行不会误中。
  return parseVad(`${r.stdout}\n${r.stderr}`, durationS).speechS >= MIN_SPEECH_S;
}
