import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Activity } from './core.ts';

export interface IngestRow {
  activity: Activity;
  raw: string;
}

export interface PollLog {
  queryKey: string;
  at: number;
  fetched: number;
  parsed: number;
  written: number;
  ok: boolean;
  ms: number;
  errorMsg?: string;
}

/** 一次轮询的成果。推不上去就整批落盘，下一轮先补发。 */
interface Batch {
  rows: IngestRow[];
  log: PollLog;
}

const TIMEOUT_MS = 20_000;

export class Ingest {
  #apiUrl: string;
  #token: string;
  #spoolDir: string;

  constructor(apiUrl: string, token: string, spoolDir: string) {
    this.#apiUrl = apiUrl.replace(/\/$/, '');
    this.#token = token;
    this.#spoolDir = spoolDir;
    mkdirSync(spoolDir, { recursive: true });
  }

  async #post(path: string, body: unknown): Promise<void> {
    // 没有超时的 fetch 加上防重叠标志就是一个永久卡死的配方：
    // API 收下连接却不回，这条查询从此再也不轮询，而进程还活着。
    const res = await fetch(`${this.#apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${path} 回了 ${res.status}`);
  }

  async #send(batch: Batch): Promise<void> {
    if (batch.rows.length > 0) await this.#post('/api/ingest/activity', batch.rows);
    await this.#post('/api/ingest/poll-log', batch.log);
  }

  #spool(batch: Batch): void {
    const name = `${batch.log.at}-${batch.log.queryKey.replace(/[^a-z0-9]/gi, '_')}.json`;
    writeFileSync(join(this.#spoolDir, name), JSON.stringify(batch));
  }

  /**
   * 先补发攒下的，再推这一批。
   *
   * 取回的行只在内存里，推不上去就没了，而热闹话务组只回溯几十分钟。
   * 入口本来就幂等，补发没有副作用。
   */
  async push(rows: IngestRow[], log: PollLog): Promise<{ sent: boolean; replayed: number }> {
    let replayed = 0;
    for (const file of readdirSync(this.#spoolDir).sort()) {
      const path = join(this.#spoolDir, file);
      try {
        await this.#send(JSON.parse(readFileSync(path, 'utf8')) as Batch);
        rmSync(path);
        replayed += 1;
      } catch {
        // 还是推不上去，留着下一轮再试，这一批也一起落盘。
        this.#spool({ rows, log });
        return { sent: false, replayed };
      }
    }

    try {
      await this.#send({ rows, log });
      return { sent: true, replayed };
    } catch (e) {
      this.#spool({ rows, log });
      console.error(`推送失败，已落盘：${(e as Error).message}`);
      return { sent: false, replayed };
    }
  }
}
