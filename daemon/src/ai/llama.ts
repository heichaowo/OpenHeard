import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TextConfig } from '../config.ts';
import { renice } from './child.ts';
import { WorkerError } from './errors.ts';

export interface LlamaTiming {
  /** 起来之后多久还不健康就放弃。 */
  healthTimeoutMs: number;
  pollMs: number;
  /** SIGTERM 之后多久没退就 SIGKILL。 */
  graceMs: number;
}

export const LLAMA_TIMING: LlamaTiming = { healthTimeoutMs: 90_000, pollMs: 500, graceMs: 5000 };

/** stderr 只留最后几行，退出时一起记进日志。 */
const RING = 20;

/** 提取用的两项设置变了，才需要换掉正在跑的那个。 */
export const sameLlama = (a: TextConfig, b: TextConfig) =>
  a.binPath === b.binPath &&
  a.modelPath === b.modelPath &&
  a.port === b.port &&
  a.idleUnloadS === b.idleUnloadS;

/**
 * 本机的 llama-server：要用的时候才起，闲着由它自己卸掉模型。
 *
 * 这台机器内存本来就紧，所以：
 * - `-np 1 -cram 0`：一个槽，不留提示缓存。缺省的缓存是 8 GiB，一个槽也比
 *   自动数量省 KV。
 * - `--sleep-idle-seconds`：闲了就卸模型，下一个请求来了再装回来。
 * - `-c 4096`：系统提示加上最长约 450 个 token 的转写加 512 的输出，装得下。
 */
export class LlamaServer {
  readonly cfg: TextConfig;
  #timing: LlamaTiming;
  #child?: ChildProcess;
  #ready = false;
  #closed = false;
  #ring: string[] = [];
  #starting?: Promise<string>;

  constructor(cfg: TextConfig, timing: LlamaTiming = LLAMA_TIMING) {
    this.cfg = cfg;
    this.#timing = timing;
  }

  get url(): string {
    return `http://127.0.0.1:${this.cfg.port}`;
  }

  /** 保证有一个健康的 llama-server，返回它的地址。 */
  ensure(): Promise<string> {
    // 停掉之后迟到的请求不能再把它拉起来，那个子进程没人管
    if (this.#closed) return Promise.reject(new WorkerError('llama-server 已经停了'));
    if (this.#child !== undefined && this.#ready) return Promise.resolve(this.url);
    this.#starting ??= this.#start().finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  async #start(): Promise<string> {
    if (this.#child === undefined) this.#spawn();
    const child = this.#child!;
    const deadline = Date.now() + this.#timing.healthTimeoutMs;
    while (Date.now() < deadline) {
      // 只认我们自己的子进程：上一次留下的实例还占着这个端口时，它的 /health
      // 会答 200，而我们这个起不来。
      if (this.#child !== child) {
        throw new WorkerError(`llama-server 没就绪就退出了：${this.#tail()}`);
      }
      try {
        const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok && this.#child === child) {
          this.#ready = true;
          return this.url;
        }
      } catch {
        // 还没起来
      }
      await sleep(this.#timing.pollMs);
    }
    this.kill();
    throw new WorkerError(`llama-server ${this.#timing.healthTimeoutMs / 1000} 秒内没就绪：${this.#tail()}`);
  }

  #spawn(): void {
    const { binPath, modelPath, port, idleUnloadS } = this.cfg;
    const child = spawn(
      binPath,
      [
        '-m', modelPath,
        '--host', '127.0.0.1',
        '--port', String(port),
        '-c', '4096',
        '-np', '1',
        '-cram', '0',
        '--no-webui',
        '--sleep-idle-seconds', String(idleUnloadS),
      ],
      // stdout 不要。stderr 必须有人读：管道满了子进程会卡在写日志上，
      // 请求做到一半没了回音，再加上没有超时，这条线从此挂死。
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    this.#child = child;
    this.#ready = false;
    this.#ring = [];
    renice(child);

    let pending = '';
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      const lines = (pending + d).split('\n');
      pending = lines.pop() ?? '';
      this.#ring.push(...lines);
      if (this.#ring.length > RING) this.#ring.splice(0, this.#ring.length - RING);
    });
    // 起不来（没有这个文件）也会有 exit，没有的话下面的健康检查等到超时
    const gone = () => {
      // 杀掉重起之后，旧的那个迟到的 exit 不能把新的标成已退出
      if (this.#child === child) {
        this.#child = undefined;
        this.#ready = false;
      }
    };
    child.on('error', (e) => {
      this.#ring.push(`起不来：${e.message}`);
      gone();
    });
    child.on('exit', (code, signal) => {
      if (pending !== '') this.#ring.push(pending);
      gone();
      console.error(`llama-server 退出了（${signal ?? code}），最后几行：${this.#tail()}`);
    });
  }

  #tail(): string {
    return this.#ring.length === 0 ? '（没有输出）' : this.#ring.join(' | ');
  }

  /** 本机请求超时了：杀掉，下一个请求会重新起。 */
  restart(): void {
    this.kill();
  }

  /** 进程要退了，没有时间等：当场杀。 */
  kill(): void {
    this.#ready = false;
    this.#child?.kill('SIGKILL');
    // 马上当成没有了：下一个请求要起新的，不用等旧的 exit 事件
    this.#child = undefined;
  }

  /** 停下，等它真的退出。先 SIGTERM，宽限期过了还在就 SIGKILL。 */
  stop(): Promise<void> {
    this.#closed = true;
    const child = this.#child;
    if (child === undefined) return Promise.resolve();
    this.#ready = false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), this.#timing.graceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
