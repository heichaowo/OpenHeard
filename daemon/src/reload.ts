import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { loadConfig } from './config.ts';
import type { AnalogConfig, DaemonConfig, Query } from './config.ts';

/** 编辑器和原子替换都会连着触发好几次事件，等它停下来再读。 */
const SETTLE_MS = 400;

const sameQueries = (a: Query[], b: Query[]) => JSON.stringify(a) === JSON.stringify(b);

const sameAnalog = (a?: AnalogConfig, b?: AnalogConfig) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 盯着配置文件，改了就把新值应用上去。
 *
 * 界面改设置走的是 api，api 把文件写回去，这边看见就跟着变，两个进程之间
 * 不用再开一条接口。配置文件本来就是两边共用的那一份。
 *
 * 读出来有问题就留在原样接着跑。手一抖存了个半截 JSON 不该让采集停摆，
 * 而且这个进程一退，launchd 会每 30 秒重来一次。
 */
export function watchConfig(
  path: string,
  applied: DaemonConfig,
  apply: { queries: (q: Query[]) => void; analog: (a: AnalogConfig | undefined) => void },
): () => void {
  let current = applied;
  let timer: NodeJS.Timeout | undefined;

  const reload = () => {
    const result = loadConfig(path);
    if (!result.ok) {
      console.error(`配置改坏了，接着用旧的：${result.problems.join('，')}`);
      return;
    }
    const next = result.config;

    if (!sameQueries(current.queries, next.queries)) apply.queries(next.queries);

    // 关掉、开起来、换信道，三种都在这一条里：apply.analog 收 undefined
    // 就是关，从 undefined 变成有值就是开，两头都有值就是换。开关一变
    // 也算数，不用等两头都配过才生效。
    if (!sameAnalog(current.analog, next.analog)) apply.analog(next.analog);

    current = next;
  };

  // 盯目录而不是盯文件。api 写设置是先写临时文件再 rename，替换之后是一个新的
  // inode，盯着文件的 watcher 还挂在旧的那个上，之后再改就永远看不见了。
  const name = basename(path);
  const watcher = watch(dirname(path), (_event, changed) => {
    if (changed !== null && changed !== name) return;
    clearTimeout(timer);
    timer = setTimeout(reload, SETTLE_MS);
  });

  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
