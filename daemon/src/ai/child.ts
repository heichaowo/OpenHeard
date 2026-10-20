import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { setPriority } from 'node:os';
import { delimiter, join } from 'node:path';
import { ItemError, WorkerError } from './errors.ts';
import type { Step } from './errors.ts';

/** 实时的 DSP 在同一个进程里跑，识别的子进程让一让。 */
const NICE = 10;

/** 在跑的子进程。kill() 进程退出前一把全杀掉，不留孤儿占着内存。 */
const running = new Set<ChildProcess>();

export function killAll(): void {
  for (const c of running) c.kill('SIGKILL');
}

/** 降低子进程的优先级。拿不到 pid 或者没权限都不影响结果。 */
export function renice(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) setPriority(child.pid, NICE);
  } catch {
    // 只是礼貌，不是前提
  }
}

export interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 异步跑一个子进程，收齐输出。
 *
 * 绝不用 *Sync：接收机的样本在这个进程的事件循环里处理，同步等 1 到 5 秒
 * 子进程，管道就满了，样本丢掉，之后每次发射的 startAt 都比墙钟落后。
 * 超时按 SIGKILL，不等它自己收尾。起不来（没有这个文件、没有权限）是环境的问题。
 */
export function runChild(bin: string, args: string[], timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    renice(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(child);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(() => reject(new WorkerError(`${bin} 超过 ${timeoutMs / 1000} 秒没跑完`)));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      // 日志只留尾巴，出错时有用的是最后几行
      stderr = (stderr + d).slice(-4000);
    });
    child.on('error', (e) => done(() => reject(new WorkerError(`起不来 ${bin}：${e.message}`))));
    child.on('close', (code) => done(() => resolve({ code, stdout, stderr })));
  });
}

/** 非零退出就是这个文件上失败了：子进程自己说了算。 */
export function ensureOk(step: Step, bin: string, r: ChildResult): void {
  if (r.code === 0) return;
  const tail = r.stderr.trim().split('\n').slice(-2).join(' | ');
  throw new ItemError(step, `${bin} 退出码 ${r.code ?? '被信号杀掉'}${tail === '' ? '' : `：${tail}`}`);
}

/**
 * 二进制在不在。带 `/` 的是路径，不带的去 PATH 里找，和 rtl_sdr 一个做法。
 * 返回找到的完整路径，没有就是 undefined。
 */
export async function findBin(bin: string): Promise<string | undefined> {
  const dirs = bin.includes('/') ? [''] : (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = dir === '' ? bin : join(dir, bin);
    try {
      await access(full, constants.X_OK);
      return full;
    } catch {
      // 下一个
    }
  }
  return undefined;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
