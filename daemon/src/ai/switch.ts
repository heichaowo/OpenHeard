import type { AiConfig } from '../config.ts';
import type { AiApi } from './api.ts';
import { sameLlama } from './llama.ts';
import { startAi } from './worker.ts';
import type { AiHandle, AiTiming } from './worker.ts';

/**
 * 正在跑的识别 worker，按配置的变化换掉。
 *
 * index.ts 和模拟守听的回调都只通过它找 worker，所以重载之后叫醒送到新的那个。
 * 换的时候要等旧的停干净：旧的 llama-server 还占着端口，新的起不来。排成一条链，
 * 连着改两次配置也不会交叉。
 */
export class AiSwitch {
  #api: AiApi;
  #timing?: Partial<AiTiming>;
  #current?: AiHandle;
  #chain: Promise<void> = Promise.resolve();

  constructor(api: AiApi, timing?: Partial<AiTiming>) {
    this.#api = api;
    this.#timing = timing;
  }

  get current(): AiHandle | undefined {
    return this.#current;
  }

  /** 换成新的配置，undefined 是停掉。返回的 Promise 在新的起来之后 resolve。 */
  apply(next: AiConfig | undefined): Promise<void> {
    this.#chain = this.#chain
      .then(async () => {
        const old = this.#current;
        // 提取的设置没变就把 llama-server 留给新的 worker，省一次装模型
        const keep =
          old?.llama !== undefined && next?.text.provider === 'local' && sameLlama(old.llama.cfg, next.text);
        // 停的时候 #current 还指着旧的，这样这期间来的 kill() 杀得到它
        await old?.stop(keep);
        this.#current =
          next === undefined
            ? undefined
            : startAi(next, this.#api, { timing: this.#timing, llama: keep ? old?.llama : undefined });
        console.log(next === undefined ? '识别停了' : '识别起来了');
      })
      .catch((e) => console.error(`换识别设置出错：${(e as Error).message}`));
    return this.#chain;
  }

  wake(): void {
    this.#current?.wake();
  }

  /** 进程要退了：子进程不会跟着 process.exit 走，留下的 llama-server 占着内存和端口。 */
  kill(): void {
    this.#current?.kill();
  }
}
