import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ensureOk, exists, findBin, runChild } from './child.ts';
import { ItemError, WorkerError } from './errors.ts';

const script = (body: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'openheard-child-')), 'tool');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

describe('runChild', () => {
  it('收齐 stdout、stderr 和退出码', async () => {
    const r = await runChild(script('echo out; echo err >&2; exit 3'), [], 10_000);
    assert.deepEqual(r, { code: 3, stdout: 'out\n', stderr: 'err\n' });
  });

  // 子进程拖着不退，等它就是把识别卡死
  it('超时按 SIGKILL 杀掉，算环境的问题', async () => {
    const t = Date.now();
    await assert.rejects(runChild(script('exec sleep 30'), [], 300), (e: unknown) => e instanceof WorkerError && /超过/.test(e.message));
    assert.ok(Date.now() - t < 5000);
  });

  it('没有这个程序、不能执行：环境的问题', async () => {
    await assert.rejects(runChild('/nonexistent/tool', [], 1000), WorkerError);
    const noExec = join(mkdtempSync(join(tmpdir(), 'openheard-child-')), 'tool');
    writeFileSync(noExec, '#!/bin/sh\n');
    await assert.rejects(runChild(noExec, [], 1000), WorkerError);
  });

  // 接收机的 DSP 在同一个进程里，识别的子进程让一让
  it('子进程的优先级降到 10', async () => {
    const r = await runChild(script('sleep 0.3; ps -o nice= -p $$'), [], 10_000);
    assert.equal(r.stdout.trim(), '10');
  });

  it('ensureOk：非零退出是这个文件的错，带上 stderr 的最后几行', () => {
    assert.doesNotThrow(() => ensureOk('asr', 'x', { code: 0, stdout: '', stderr: '' }));
    assert.throws(
      () => ensureOk('asr', 'x', { code: 2, stdout: '', stderr: 'a\nb\nc\n' }),
      (e: unknown) => e instanceof ItemError && e.step === 'asr' && /退出码 2：b \| c/.test(e.message),
    );
  });
});

describe('找程序和模型', () => {
  it('带 / 的是路径，不带的去 PATH 里找', async () => {
    assert.equal(await findBin('/bin/sh'), '/bin/sh');
    assert.match((await findBin('sh'))!, /\/sh$/);
    assert.equal(await findBin('definitely-not-installed-xyz'), undefined);
    assert.equal(await findBin('/nonexistent/tool'), undefined);
  });

  it('不可执行的文件不算程序', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'openheard-child-')), 'tool');
    writeFileSync(path, 'x');
    assert.equal(await findBin(path), undefined);
    assert.equal(await exists(path), true);
    assert.equal(await exists('/nonexistent/m.bin'), false);
  });
});
