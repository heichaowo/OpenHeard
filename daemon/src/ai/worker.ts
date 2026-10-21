import { join } from 'node:path';
import type { AiConfig } from '../config.ts';
import { AiApi } from './api.ts';
import type { AiResult, TodoItem } from './api.ts';
import { asrModelName, transcribe } from './asr.ts';
import { exists, findBin, killAll } from './child.ts';
import { ItemError, WorkerError } from './errors.ts';
import type { Step } from './errors.ts';
import { filterTranscript } from './filter.ts';
import { LlamaServer, LLAMA_TIMING } from './llama.ts';
import type { LlamaTiming } from './llama.ts';
import { extract, textModelName } from './text.ts';
import { detectSpeech } from './vad.ts';

export interface AiTiming {
  /** todo 是空的时候等多久再问。 */
  idleMs: number;
  /** 预检不过时多久再查一遍。 */
  recheckMs: number;
  /** 环境出错之后第一次退避多久，之后翻倍。 */
  backoffMinMs: number;
  backoffMaxMs: number;
  /** 状态多久至少报一次，api 重启之后才补得回来。 */
  statusMs: number;
  /** 汇总日志的间隔。 */
  statsMs: number;
  /** 提取请求的超时。测试里缩短，线上用 TEXT_TIMEOUT_MS。 */
  textTimeoutMs?: number;
  llama: LlamaTiming;
}

export const AI_TIMING: AiTiming = {
  idleMs: 10_000,
  recheckMs: 60_000,
  backoffMinMs: 60_000,
  backoffMaxMs: 600_000,
  statusMs: 60_000,
  statsMs: 3_600_000,
  llama: LLAMA_TIMING,
};

/** 一次向 api 要几条。 */
const BATCH = 10;
/** Retry-After 再长也不等过一小时。 */
const RETRY_AFTER_MAX_MS = 3_600_000;

export interface AiHandle {
  readonly cfg: AiConfig;
  /** 本机的 llama-server。重载时提取的设置没变就把它留给新的 worker。 */
  readonly llama?: LlamaServer;
  /** 有新录音了，别等满 10 秒。 */
  wake(): void;
  /** 停下。不留着 llama-server 就等它退出之后才 resolve。 */
  stop(keepLlama?: boolean): Promise<void>;
  /** 进程要退了：同步杀掉所有子进程。 */
  kill(): void;
}

/** 哪些步骤开着，api 据此挑出还要做的录音。 */
export function stepsOf(cfg: AiConfig): Step[] {
  const steps: Step[] = [];
  if (cfg.vad.provider === 'local') steps.push('vad');
  if (cfg.asr.provider !== 'off') steps.push('asr');
  if (cfg.text.provider !== 'off') steps.push('text');
  return steps;
}

/** 开着的本机步骤要用的文件都在不在。缺的写成人看得懂的话。 */
export async function preflight(cfg: AiConfig): Promise<string[]> {
  const missing: string[] = [];
  const bin = async (what: string, path: string) => {
    if ((await findBin(path)) === undefined) missing.push(`${what}程序 ${path}`);
  };
  const model = async (what: string, path: string) => {
    if (!(await exists(path))) missing.push(`${what}模型 ${path}`);
  };
  if (cfg.vad.provider === 'local') {
    await bin('人声判断', cfg.vad.binPath);
    await model('人声判断', cfg.vad.modelPath);
  }
  if (cfg.asr.provider === 'local') {
    await bin('识别', cfg.asr.binPath);
    await model('识别', cfg.asr.modelPath);
  }
  if (cfg.text.provider === 'local') {
    await bin('提取', cfg.text.binPath);
    await model('提取', cfg.text.modelPath);
  }
  return missing;
}

/** 一段时间里做了什么，每小时记一行。 */
export class Stats {
  processed = 0;
  noSpeech = 0;
  meaningless = 0;
  errors = 0;
  #ms = 0;

  add(r: AiResult, ms: number): void {
    this.#ms += ms;
    if (r.error !== undefined) {
      this.errors += 1;
      return;
    }
    this.processed += 1;
    if (r.hasSpeech === false) this.noSpeech += 1;
    if (r.hasSpeech === false || r.category === 'test' || r.category === 'noise') this.meaningless += 1;
  }

  line(): string {
    const n = this.processed + this.errors;
    const mean = n === 0 ? 0 : this.#ms / n / 1000;
    return `识别小结：处理 ${this.processed} 条，无人声 ${this.noSpeech}，无意义 ${this.meaningless}，出错 ${this.errors}，平均 ${mean.toFixed(1)} 秒/条`;
  }

  reset(): void {
    this.processed = this.noSpeech = this.meaningless = this.errors = this.#ms = 0;
  }
}

/** 同一批里的失败先扣着，等下一条的结果再定，批末才推。 */
interface Held {
  step: Step;
  result: AiResult;
  ms: number;
}

/**
 * 同一步连着两条失败（中间没有成功过，跨批次也算）多半不是这两条的错，当成环境的问题，
 * 两条都记成嫌疑。嫌疑不能永远挡住队列，也不能把环境的错记到录音头上，所以下一批
 * 先做别的条目来对照：
 * - 别的条目在这一步通过了：环境没问题，嫌疑条目再失败就记 error（verified）
 * - 别的条目在这一步也失败了：确是环境的问题，退避，什么都不记，嫌疑作废
 * - 批里只有嫌疑条目，没得对照：嫌疑条目再失败就记 error，队列也得往前走
 */
interface Suspects {
  step: Step;
  ids: Set<string>;
  verified: boolean;
}

/**
 * 识别 worker：一个循环，一条一条做，结果推给 api。
 *
 * 所有子进程都是异步起的，从不用 *Sync：接收机的 DSP 和这个循环在同一个事件
 * 循环上。循环里抛什么都接住，不能让一个识别的错把采集的进程带走。
 */
export function startAi(
  cfg: AiConfig,
  api: AiApi,
  opts: { timing?: Partial<AiTiming>; llama?: LlamaServer } = {},
): AiHandle {
  const timing: AiTiming = { ...AI_TIMING, ...opts.timing };
  const steps = stepsOf(cfg);
  const llama =
    cfg.text.provider === 'local' ? (opts.llama ?? new LlamaServer(cfg.text, timing.llama)) : undefined;
  const stats = new Stats();

  let stopped = false;
  let pendingWake = false;
  let backoffMs = 0;
  let waiter: { done: () => void; interruptible: boolean } | undefined;
  let lastStatus: { ok: boolean; message: string; at: number } | undefined;
  let lastMissing = '';
  /** 最近一条失败的录音，成功一条就清掉。跨批次留着：线上一次只来一条，批次内扣着认不出来。 */
  let lastFail: { step: Step; id: string } | undefined;
  let suspects: Suspects | undefined;

  /** 等一会儿。wake 只打断空闲的等待，退避和预检的等待只有 stop 能打断。 */
  const wait = (ms: number, interruptible: boolean) =>
    new Promise<void>((resolve) => {
      if (stopped || (interruptible && pendingWake)) {
        pendingWake = false;
        return resolve();
      }
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        waiter = undefined;
        resolve();
      }
      waiter = { done, interruptible };
    });

  const report = async (ok: boolean, message: string) => {
    const now = Date.now();
    if (lastStatus && lastStatus.ok === ok && lastStatus.message === message && now - lastStatus.at < timing.statusMs) {
      return;
    }
    lastStatus = { ok, message, at: now };
    await api.status(ok, message);
  };

  /** 一条录音做到哪算哪，出错时已经做完的部分不丢。done 记下通过了哪几步。 */
  async function processItem(item: TodoItem, out: AiResult, done: Set<Step>): Promise<boolean> {
    if (!/^[\w.-]+$/.test(item.id)) throw new ItemError('asr', `录音 id 不合法：${item.id}`);
    const wav = join(cfg.recordingsDir, `${item.id}.wav`);
    let raw = item.transcript !== undefined && item.transcript !== '' ? item.transcript : undefined;
    let hasSpeech = item.hasSpeech;
    let worked = false;

    // 带着转写回来的只补提取，不再过人声判断和识别
    if (raw === undefined) {
      if (cfg.vad.provider === 'local' && hasSpeech === undefined) {
        hasSpeech = await detectSpeech(cfg.vad, wav, item.durationS);
        done.add('vad');
        out.hasSpeech = hasSpeech;
        worked = true;
        if (!hasSpeech) return true;
      }
      if (cfg.asr.provider === 'off') return worked;
      raw = await transcribe(cfg.asr, wav);
      done.add('asr');
      out.transcript = raw;
      out.asrModel = asrModelName(cfg.asr);
      worked = true;
    } else {
      out.transcript = raw;
      if (hasSpeech !== undefined) out.hasSpeech = hasSpeech;
    }

    const filtered = filterTranscript(raw, cfg.asr.prompt);
    if (!filtered.hasSpeech) {
      out.hasSpeech = false;
      return true;
    }
    if (cfg.text.provider === 'off') return worked;

    const localUrl = llama === undefined ? undefined : await llama.ensure();
    try {
      const got = await extract(
        cfg.text,
        { transcript: filtered.text, mine: item.mine, channel: item.channel },
        localUrl,
        timing.textTimeoutMs,
      );
      done.add('text');
      out.category = got.category;
      out.fields = got.fields;
      out.textModel = textModelName(cfg.text);
    } catch (e) {
      // 本机超时：多半是模型卡住了，杀掉，下一次重新起
      if (e instanceof WorkerError && e.timedOut) llama?.restart();
      throw e;
    }
    return true;
  }

  async function post(result: AiResult, ms: number): Promise<void> {
    await api.post([result]);
    if (stopped) return;
    stats.add(result, ms);
    if (result.error === undefined) {
      backoffMs = 0;
      lastFail = undefined;
      await report(true, '正常');
    }
  }

  /** 做完这一批。环境出错抛 WorkerError，其余自己消化。返回推上去了几条。 */
  async function runBatch(items: TodoItem[]): Promise<number> {
    let pushed = 0;
    let held: Held | undefined;
    const flush = async () => {
      const h = held;
      held = undefined;
      if (h === undefined || stopped) return;
      await post(h.result, h.ms);
      pushed += 1;
    };

    // 有嫌疑的先放后面，让别的条目先来对照环境
    const probe = suspects;
    const ordered =
      probe === undefined
        ? items
        : [...items.filter((i) => !probe.ids.has(i.id)), ...items.filter((i) => probe.ids.has(i.id))];

    for (const item of ordered) {
      if (stopped) return pushed;
      const started = Date.now();
      const out: AiResult = { activityId: item.id };
      const done = new Set<Step>();
      try {
        const worked = await processItem(item, out, done);
        if (stopped) return pushed;
        if (!worked) continue;
        await flush();
        await post(out, Date.now() - started);
        pushed += 1;
        if (suspects !== undefined) {
          // 别的条目通过了嫌疑的那一步：环境没问题
          if (!suspects.ids.has(item.id) && done.has(suspects.step)) suspects.verified = true;
        }
      } catch (e) {
        if (stopped) return pushed;
        if (!(e instanceof ItemError)) throw e;
        console.error(`识别失败 ${item.id}（${e.step}）：${e.message}`);
        const ms = Date.now() - started;
        const sus = suspects;
        if (sus !== undefined && sus.step === e.step) {
          if (sus.ids.has(item.id)) {
            // 嫌疑条目又失败了，不管有没有对照过，都是它自己的问题，记下来让队列往前走。
            // 不进 lastFail：几个嫌疑条目挨着失败不能再触发一次暂停。
            await flush();
            lastFail = undefined;
            await post({ ...out, error: e.message }, ms);
            pushed += 1;
            continue;
          }
          if (!sus.verified) {
            suspects = undefined;
            lastFail = undefined;
            held = undefined;
            throw new WorkerError(
              `${[...sus.ids].join('、')} 在 ${e.step} 上失败，换 ${item.id} 一试也失败，是环境的问题：${e.message}`,
            );
          }
        }
        const last = lastFail;
        if (last !== undefined && last.step === e.step && last.id !== item.id) {
          // 第一条要么扣在 held 里，要么上一批已经推了 error。这一条不推。
          suspects = { step: e.step, ids: new Set([last.id, item.id]), verified: false };
          held = undefined;
          lastFail = undefined;
          throw new WorkerError(
            `连着两条录音在 ${e.step} 上失败，当成环境的问题，先做别的条目对照。嫌疑：${last.id}、${item.id}。${e.message}`,
          );
        }
        await flush();
        held = { step: e.step, result: { ...out, error: e.message }, ms };
        lastFail = { step: e.step, id: item.id };
      }
    }
    await flush();
    // 嫌疑只管紧接着的这一批。做完了，不管对照上没有，都不再留着。
    suspects = undefined;
    return pushed;
  }

  async function cycle(): Promise<void> {
    const missing = await preflight(cfg);
    if (stopped) return;
    if (missing.length > 0) {
      // 没有文件就不去要活：要来了也做不了，只会把重试次数耗掉
      const message = `缺文件，识别没有开始：${missing.join('，')}`;
      if (message !== lastMissing) console.error(message);
      lastMissing = message;
      await report(false, message);
      await wait(timing.recheckMs, false);
      return;
    }
    if (lastMissing !== '') console.log('识别要用的文件都在了');
    lastMissing = '';

    pendingWake = false;
    const items = await api.todo(BATCH, steps);
    if (stopped) return;
    if (items.length > 0) {
      const pushed = await runBatch(items);
      // 一条都没推上去也要歇一歇，否则 api 一直给同一批做不了的，这里就是空转
      if (pushed > 0 || stopped) return;
    }
    await report(true, '正常');
    await wait(timing.idleMs, true);
  }

  async function backoff(e: WorkerError): Promise<void> {
    backoffMs = backoffMs === 0 ? timing.backoffMinMs : Math.min(backoffMs * 2, timing.backoffMaxMs);
    const waitMs = Math.max(backoffMs, Math.min((e.retryAfterS ?? 0) * 1000, RETRY_AFTER_MAX_MS));
    console.error(`识别出了环境的问题，${Math.round(waitMs / 1000)} 秒后再试：${e.message}`);
    await report(false, e.message);
    await wait(waitMs, false);
  }

  const loop = (async () => {
    while (!stopped) {
      try {
        await cycle();
      } catch (e) {
        if (stopped) break;
        try {
          await backoff(e instanceof WorkerError ? e : new WorkerError(`识别循环出错：${(e as Error).message}`));
        } catch {
          // 连退避自己都出错就直接进下一轮，循环不能死
        }
      }
    }
  })();
  void loop;

  const statsTimer = setInterval(() => {
    console.log(stats.line());
    stats.reset();
  }, timing.statsMs);
  statsTimer.unref();

  const halt = () => {
    stopped = true;
    clearInterval(statsTimer);
    waiter?.done();
    killAll();
  };

  return {
    cfg,
    llama,
    wake() {
      if (waiter?.interruptible) waiter.done();
      else pendingWake = true;
    },
    async stop(keepLlama = false) {
      halt();
      if (!keepLlama) await llama?.stop();
    },
    kill() {
      halt();
      llama?.kill();
    },
  };
}
