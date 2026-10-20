export type Step = 'vad' | 'asr' | 'text';

/**
 * 这一条录音本身的问题：读不了、提供方说这份输入不行、子进程在这个文件上失败、
 * 回的不是 JSON。记在这条上，算一次重试。
 */
export class ItemError extends Error {
  readonly step: Step;
  constructor(step: Step, message: string) {
    super(message);
    this.step = step;
  }
}

/**
 * 环境的问题：二进制或模型没了、llama-server 起不来、网络断了、超时、
 * 401/403/404/429/5xx。不记在录音上，否则一次配置失误就把整批积压的重试次数用光。
 * 这一条留着，退避之后再做。
 */
export class WorkerError extends Error {
  /** 服务端给的 Retry-After，秒。 */
  readonly retryAfterS?: number;
  /** 是超时。本机的 llama-server 超时了要杀掉重起。 */
  readonly timedOut: boolean;
  constructor(message: string, retryAfterS?: number, timedOut = false) {
    super(message);
    this.retryAfterS = retryAfterS;
    this.timedOut = timedOut;
  }
}

/** 提供方回了非 2xx。按状态码分两类。 */
export function httpError(step: Step, what: string, res: Response, body: string): Error {
  const detail = `${what} 回了 ${res.status}${body === '' ? '' : `：${body.slice(0, 200)}`}`;
  if (res.status === 400 || res.status === 413 || res.status === 422) return new ItemError(step, detail);
  const after = Number(res.headers.get('retry-after'));
  return new WorkerError(detail, Number.isFinite(after) && after > 0 ? after : undefined);
}

/** fetch 自己抛的：网络断了、超时，都是环境的问题。 */
export function networkError(what: string, e: unknown): WorkerError {
  const err = e as Error;
  const timedOut = err.name === 'TimeoutError';
  return new WorkerError(`${what} 连不上或者超时：${timedOut ? '超时' : err.message}`, undefined, timedOut);
}
