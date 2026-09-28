import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { Ingest } from './ingest.ts';
import type { IngestRow, PollLog } from './ingest.ts';

const row: IngestRow = {
  activity: { id: 'fm-1', origin: 'sdr-fm', startAt: 1_789_000_000, durationS: 3, mine: false, channel: '438.500' },
  raw: '{}',
};
const log: PollLog = { queryKey: '438.500', at: 1_789_000_003, fetched: 1, parsed: 1, written: 0, ok: true, ms: 0 };

afterEach(() => mock.restoreAll());

describe('Ingest.close', () => {
  // SIGTERM 时停接收机，收尾的那次发射马上就 process.exit 了。推送要在
  // 调用那一刻同步落盘，不能等 fetch。
  it('关了之后推送不走网络，调用当场就落盘', () => {
    const fetch = mock.method(globalThis, 'fetch', async () => new Response('{}'));
    const dir = mkdtempSync(join(tmpdir(), 'openheard-spool-'));
    const ingest = new Ingest('http://127.0.0.1:9', 'x'.repeat(32), dir);

    ingest.close();
    void ingest.push([row], log);

    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')).rows, [row]);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('下次起来，落盘的那一批先补发', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openheard-spool-'));
    const before = new Ingest('http://127.0.0.1:9', 'x'.repeat(32), dir);
    before.close();
    void before.push([row], log);

    const paths: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string) => {
      paths.push(new URL(url).pathname);
      return new Response(JSON.stringify({ written: 1 }), { headers: { 'content-type': 'application/json' } });
    });
    const after = new Ingest('http://127.0.0.1:9', 'x'.repeat(32), dir);
    const result = await after.push([], { ...log, at: log.at + 60, fetched: 0, parsed: 0 });

    assert.deepEqual(result, { sent: true, replayed: 1 });
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(paths[0], '/api/ingest/activity');
  });

  // 两个信道名只差几个汉字，过滤成 ASCII 之后一样。退出时两个信道同一秒收尾，
  // 两批不能写到同一个文件上。
  it('同一秒、信道名只差汉字的两批各落一个文件', () => {
    mock.method(globalThis, 'fetch', async () => new Response('{}'));
    const dir = mkdtempSync(join(tmpdir(), 'openheard-spool-'));
    const ingest = new Ingest('http://127.0.0.1:9', 'x'.repeat(32), dir);
    ingest.close();
    void ingest.push([row], { ...log, queryKey: 'analog:本地中继' });
    void ingest.push([{ ...row, activity: { ...row.activity, id: 'fm-2' } }], { ...log, queryKey: 'analog:市区中继' });

    const ids = readdirSync(dir)
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).rows[0].activity.id)
      .sort();
    assert.deepEqual(ids, ['fm-1', 'fm-2']);
  });

  it('关了之后不再报电台状态', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    const ingest = new Ingest('http://127.0.0.1:9', 'x'.repeat(32), mkdtempSync(join(tmpdir(), 'openheard-spool-')));
    ingest.close();
    await ingest.radio({ freqMhz: 438.5 });
    assert.equal(fetch.mock.callCount(), 0);
  });
});
