import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AsrConfig } from '../config.ts';
import { ensureOk, runChild } from './child.ts';
import { httpError, ItemError, networkError } from './errors.ts';

const LOCAL_TIMEOUT_MS = 120_000;
const CLOUD_TIMEOUT_MS = 60_000;

/** 写进 asr_model 的名字。本机的用模型文件名，云端的用配置里的 model。 */
export const asrModelName = (cfg: AsrConfig) => (cfg.provider === 'local' ? basename(cfg.modelPath) : cfg.model);

async function readWav(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (e) {
    // 录音没了或者读不了，是这一条的问题，不是环境的问题
    throw new ItemError('asr', `读不了录音 ${basename(path)}：${(e as Error).message}`);
  }
}

/** whisper-cli 一段一行，拼成一段。 */
const joinLines = (stdout: string) =>
  stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');

async function local(cfg: AsrConfig, wav: string): Promise<string> {
  const args = ['-m', cfg.modelPath, '-l', cfg.language];
  if (cfg.prompt !== '') args.push('--prompt', cfg.prompt);
  // -nt 不要时间戳，-np 不要日志，只剩转写。解码参数用命令行缺省（束搜索 5），
  // 实测服务端缺省的贪心解码会把 CQTEST 转成 QQZ。
  args.push('-nt', '-np', '-f', wav);
  const r = await runChild(cfg.binPath, args, LOCAL_TIMEOUT_MS);
  ensureOk('asr', cfg.binPath, r);
  return joinLines(r.stdout);
}

async function post(cfg: AsrConfig, path: string, init: RequestInit): Promise<unknown> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      method: 'POST',
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
  } catch (e) {
    throw networkError(`识别 ${url}`, e);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw httpError('asr', `识别 ${url}`, res, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new ItemError('asr', `识别服务回的不是 JSON：${text.slice(0, 100)}`);
  }
}

/** multipart 里每个字段都是文本，对象写成 JSON。 */
const formValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

async function transcriptions(cfg: AsrConfig, wav: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(await readWav(wav))], { type: 'audio/wav' }), basename(wav));
  form.append('model', cfg.model);
  form.append('language', cfg.language);
  if (cfg.prompt !== '') form.append('prompt', cfg.prompt);
  form.append('response_format', 'json');
  for (const [k, v] of Object.entries(cfg.extraBody)) form.set(k, formValue(v));
  const out = (await post(cfg, '/audio/transcriptions', { body: form })) as { text?: unknown };
  if (typeof out?.text !== 'string') throw new ItemError('asr', '识别服务的回应里没有 text');
  return out.text;
}

async function chatAudio(cfg: AsrConfig, wav: string): Promise<string> {
  const data = (await readWav(wav)).toString('base64');
  const body = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${data}` } }],
      },
    ],
    asr_options: { language: cfg.language },
    ...cfg.extraBody,
  };
  const out = (await post(cfg, '/chat/completions', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })) as { choices?: { message?: { content?: unknown } }[] };
  const content = out?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new ItemError('asr', '识别服务的回应里没有 choices[0].message.content');
  return content;
}

/** 转写一段录音，返回原始文字。幻觉在后面一步剔。 */
export async function transcribe(cfg: AsrConfig, wav: string): Promise<string> {
  switch (cfg.provider) {
    case 'local':
      return local(cfg, wav);
    case 'openai-transcriptions':
      return transcriptions(cfg, wav);
    case 'chat-audio':
      return chatAudio(cfg, wav);
    case 'off':
      throw new Error('识别关着，不该走到这里');
  }
}
