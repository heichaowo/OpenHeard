import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { recordingsSize, removeRecordings } from './recordings.ts';

const withFiles = (names: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'openheard-rec-'));
  for (const n of names) writeFileSync(join(dir, n), 'RIFF1234');
  return dir;
};

describe('removeRecordings', () => {
  // 每次静噪打开都写一个 wav。发射行按保留期裁掉之后，录音不跟着删的话，
  // 那个目录只涨不减，而且涨得比库里任何一张表都快。
  it('删掉给到的那几个，别的不动', () => {
    const dir = withFiles(['a1.wav', 'a2.wav', 'a3.wav']);

    assert.equal(removeRecordings(dir, ['a1', 'a3']), 2);

    assert.equal(existsSync(join(dir, 'a1.wav')), false);
    assert.equal(existsSync(join(dir, 'a2.wav')), true);
    assert.equal(existsSync(join(dir, 'a3.wav')), false);
  });

  it('没有录音的发射行不报错', () => {
    const dir = withFiles(['a1.wav']);
    assert.equal(removeRecordings(dir, ['没有这个', 'a1']), 1);
  });

  it('没配模拟守听时什么都不做', () => {
    assert.equal(removeRecordings(undefined, ['a1']), 0);
  });
});

describe('recordingsSize', () => {
  it('只数 wav，给出个数和字节', () => {
    const dir = withFiles(['a1.wav', 'a2.wav', '说明.txt']);
    assert.deepEqual(recordingsSize(dir), { files: 2, bytes: 16 });
  });

  it('目录不在或者没配时是零', () => {
    assert.deepEqual(recordingsSize(undefined), { files: 0, bytes: 0 });
    assert.deepEqual(recordingsSize('/nope/nope'), { files: 0, bytes: 0 });
  });
});
