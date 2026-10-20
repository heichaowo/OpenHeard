import { WorkerError } from './errors.ts';
import type { AiFields, Category } from './text.ts';

/** 向 api 要的一条待识别的录音。 */
export interface TodoItem {
  id: string;
  startAt: number;
  durationS: number;
  mine: boolean;
  channel?: string;
  /** 以前跑过人声判断的结果。 */
  hasSpeech?: boolean;
  /** 以前识别出来的原始文字。带着它的只补提取。 */
  transcript?: string;
}

export interface AiResult {
  activityId: string;
  hasSpeech?: boolean;
  transcript?: string;
  category?: Category;
  fields?: AiFields;
  asrModel?: string;
  textModel?: string;
  error?: string;
}

const TIMEOUT_MS = 20_000;

/**
 * 识别用到的三个 api 入口。和 Ingest 分开：Ingest 的推送要落盘补发，
 * 这里的请求没有这个需要，失败了就是退避之后再要一次。
 */
export class AiApi {
  #apiUrl: string;
  #token: string;

  constructor(apiUrl: string, token: string) {
    this.#apiUrl = apiUrl.replace(/\/$/, '');
    this.#token = token;
  }

  async #call(path: string, init: RequestInit = {}): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.#apiUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          authorization: `Bearer ${this.#token}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new WorkerError(`api ${path} 连不上：${(e as Error).message}`);
    }
    if (!res.ok) {
      const after = Number(res.headers.get('retry-after'));
      throw new WorkerError(`api ${path} 回了 ${res.status}`, Number.isFinite(after) && after > 0 ? after : undefined);
    }
    if (res.status === 204) return undefined;
    return await res.json().catch(() => {
      throw new WorkerError(`api ${path} 回的不是 JSON`);
    });
  }

  /** 新的排在前面，已有的录音也在里面。 */
  async todo(limit: number, steps: string[]): Promise<TodoItem[]> {
    const out = (await this.#call(`/api/ingest/ai/todo?limit=${limit}&steps=${steps.join(',')}`)) as {
      items?: TodoItem[];
    };
    if (!Array.isArray(out?.items)) throw new WorkerError('api 的 todo 回应里没有 items');
    return out.items;
  }

  async post(results: AiResult[]): Promise<void> {
    await this.#call('/api/ingest/ai', { method: 'POST', body: JSON.stringify(results) });
  }

  /** 报告识别这边的状态。只在内存里，过期的没有价值，推不上去就算了。 */
  async status(ok: boolean, message: string): Promise<void> {
    try {
      await this.#call('/api/ingest/ai/status', { method: 'POST', body: JSON.stringify({ ok, message }) });
    } catch {
      // api 重启的那几秒里会连着失败，不值得刷日志
    }
  }
}
