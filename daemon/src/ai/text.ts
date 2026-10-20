import { basename } from 'node:path';
import type { TextConfig } from '../config.ts';
import { httpError, ItemError, networkError } from './errors.ts';

/** 本机 120 秒：从闲置休眠里醒来要装一遍模型。云端 60 秒。 */
export const TEXT_TIMEOUT_MS = { local: 120_000, cloud: 60_000 };

export interface AiFields {
  call?: string;
  calledCall?: string;
  qth?: string;
  rst?: string;
  device?: string;
  antenna?: string;
  power?: string;
  height?: string;
}
export type Category = 'qso' | 'test' | 'noise';
export interface Extracted {
  category?: Category;
  fields: AiFields;
}

/** 写进 text_model 的名字。 */
export const textModelName = (cfg: TextConfig) => (cfg.provider === 'local' ? basename(cfg.modelPath) : cfg.model);

/**
 * 提取用的系统提示。
 *
 * 必须带「JSON」这个词：DeepSeek 和通义的 json_object 模式没有它会拒绝，或者
 * 一直吐空白。「只有噪声返回 category noise」替代了 spec 里原来的「返回空对象」，
 * 否则分不出噪声和没提取到字段。
 */
export const SYSTEM_PROMPT = `你是业余无线电通联记录助手。用户给你一段对讲机发射的语音转写，转写可能有错字、同音字和漏字。从里面提取通联信息。

只返回一个 JSON 对象，不要任何别的文字。

category 一定要有，三选一：
- qso：在呼叫、应答、通联、报告信号或聊天。
- test：试机、试音、对着话筒数数或喂喂喂，例如「测试测试」「1234 试麦」。
- noise：转写里没有一句能听懂的话，只有杂音、碎字或乱码。只有噪声就返回 {"category":"noise"}，不要返回空对象。

其余字段只在转写里明确说出口时才写，没说的一律省略。不推断，不编造，不猜。
- call：说话人自己的呼号。
- calledCall：说话人正在呼叫或回应的对方呼号。
- qth：说话人所在的地方，写城市或区县。
- rst：说话人给对方的信号报告，写成两位或三位数字，例如 59、57、579。
- device：说话人用的设备。
- antenna：说话人用的天线。
- power：功率，写成数字加 W，例如 5W、10W。
- height：天线高度，带单位，例如 30米。

呼号用 NATO 字母或中文口语读出来时，解码成大写、没有空格的呼号。「Bravo Golf Zero Charlie Golf」写成 BG0CG，「B G 零 C G」也写成 BG0CG。

示例：{"category":"qso","call":"BH1ABC","calledCall":"BG0CG","rst":"59","qth":"成都"}`;

/** 告诉模型这是谁在说话、在哪个信道上：「本台」说的话，call 就是本台的呼号。 */
export function userMessage(transcript: string, mine: boolean, channel: string | undefined): string {
  return [
    `说话人：${mine ? '本台自己' : '别的电台，不是本台'}`,
    ...(channel === undefined || channel === '' ? [] : [`信道：${channel}`]),
    `转写：${transcript}`,
  ].join('\n');
}

const CATEGORIES = ['qso', 'test', 'noise'];
const KEYS = ['call', 'calledCall', 'qth', 'rst', 'device', 'antenna', 'power', 'height'] as const;

/**
 * 读模型的回复。不是 JSON 对象就是这一条的错。
 * 没有合法的 category 就不设，字段照留：宁可不判，不要乱判成无意义。
 */
export function parseExtraction(content: string): Extracted {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    throw new ItemError('text', `文字模型回的不是 JSON：${content.slice(0, 100)}`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new ItemError('text', `文字模型回的不是 JSON 对象：${content.slice(0, 100)}`);
  }
  const o = obj as Record<string, unknown>;
  const fields: AiFields = {};
  for (const k of KEYS) {
    const given = o[k];
    let v = typeof given === 'number' ? String(given) : typeof given === 'string' ? given.trim() : '';
    if (v === '') continue;
    // 小模型常把「5 瓦」写成数字 5。只补单位，别的由 api 校验
    if (k === 'power' && /^\d+(\.\d+)?$/.test(v)) v = `${v}W`;
    fields[k] = v;
  }
  const category = CATEGORIES.includes(o.category as string) ? (o.category as Category) : undefined;
  return { category, fields };
}

export interface ExtractInput {
  transcript: string;
  mine: boolean;
  channel?: string;
}

/**
 * 提取。本机的就是 llama-server 的 OpenAI 兼容接口，云端的是配置里的地址，
 * 请求体一样：temperature 0、max_tokens 512、json_object，最后合并 extraBody。
 * 厂商各自的开关（关思考、限输出）全在 extraBody 里，这里不认厂商。
 */
export async function extract(
  cfg: TextConfig,
  input: ExtractInput,
  /** 本机时 llama-server 的地址，已经确认健康。 */
  localUrl?: string,
  timeoutMs = cfg.provider === 'local' ? TEXT_TIMEOUT_MS.local : TEXT_TIMEOUT_MS.cloud,
): Promise<Extracted> {
  const isLocal = cfg.provider === 'local';
  const url = isLocal
    ? `${localUrl}/v1/chat/completions`
    : `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: textModelName(cfg),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage(input.transcript, input.mine, input.channel) },
    ],
    temperature: 0,
    max_tokens: 512,
    response_format: { type: 'json_object' },
    ...cfg.extraBody,
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(isLocal ? {} : { authorization: `Bearer ${cfg.apiKey}` }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw networkError(`提取 ${url}`, e);
  }
  const raw = await res.text().catch(() => '');
  if (!res.ok) throw httpError('text', `提取 ${url}`, res, raw);
  let content: unknown;
  try {
    content = (JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  } catch {
    throw new ItemError('text', `文字模型回的不是 JSON：${raw.slice(0, 100)}`);
  }
  // DeepSeek 偶尔回空内容，和回了非 JSON 一样处理
  if (typeof content !== 'string') throw new ItemError('text', '文字模型的回应里没有 content');
  return parseExtraction(content);
}
