import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeMdc, deinterleave, encodeMdc, fecBytes, interleave, mdcCrc } from './mdc.ts';

const FS = 24000;
const ID = 0x6460;

/** 调研给出的参考帧：op=01 arg=80 id=193C。三个最容易写反的环节靠它定死。 */
const REF_MSG = [0x01, 0x80, 0x19, 0x3c, 0xce, 0x56, 0x00];
const REF_FEC = [0x65, 0x80, 0x2f, 0x49, 0xbe, 0x67, 0x1e];

describe('参考向量', () => {
  it('CRC 只覆盖前 4 字节，算出 0x56CE', () => {
    assert.equal(mdcCrc([0x01, 0x80, 0x19, 0x3c]), 0x56ce);
  });

  it('FEC 逐字节对上参考帧', () => {
    assert.deepEqual(fecBytes(REF_MSG), REF_FEC);
  });

  it('交织往返一致', () => {
    const flat = [...REF_MSG, ...REF_FEC];
    assert.deepEqual(deinterleave(interleave(flat)), flat);
  });

  it('CRC 换一位输入就变', () => {
    assert.notEqual(mdcCrc([0x01, 0x80, 0x19, 0x3d]), 0x56ce);
    assert.notEqual(mdcCrc([0x01, 0x80, 0x18, 0x3c]), 0x56ce);
  });
});

describe('调制解调往返', () => {
  it('解出本台 ID', () => {
    const frames = decodeMdc(encodeMdc(0x01, 0x80, ID, FS), FS);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.unitId, ID);
    assert.equal(frames[0]!.op, 0x01);
  });

  it('前导长度变了也要解得出，不能靠它做时序假设', () => {
    for (const pre of [24, 40, 56, 128]) {
      const frames = decodeMdc(encodeMdc(0x01, 0x80, ID, FS, pre), FS);
      assert.equal(frames.length, 1, `前导 ${pre} 位时解不出`);
      assert.equal(frames[0]!.unitId, ID);
    }
  });

  it('极性反了也要解得出', () => {
    const audio = encodeMdc(0x01, 0x80, ID, FS);
    const flipped = Float64Array.from(audio, (v) => -v);
    assert.equal(decodeMdc(flipped, FS)[0]?.unitId, ID);
  });

  it('前后垫静音不影响，位置报得出来', () => {
    const burst = encodeMdc(0x01, 0x80, ID, FS);
    const pad = FS; // 1 秒
    const audio = new Float64Array(pad * 2 + burst.length);
    audio.set(burst, pad);
    const frames = decodeMdc(audio, FS);
    assert.equal(frames.length, 1);
    assert.ok(Math.abs(frames[0]!.atSample - pad) < FS * 0.05, `位置 ${frames[0]!.atSample}`);
  });

  it('两次突发解出两帧', () => {
    const a = encodeMdc(0x01, 0x80, ID, FS);
    const b = encodeMdc(0x01, 0x80, 0x1234, FS);
    const gap = FS;
    const audio = new Float64Array(a.length + gap + b.length);
    audio.set(a, 0);
    audio.set(b, a.length + gap);
    const ids = decodeMdc(audio, FS).map((f) => f.unitId);
    assert.deepEqual(ids, [ID, 0x1234]);
  });

  it('不同 unit ID 各自解对', () => {
    for (const id of [0x0001, 0x6460, 0xabcd, 0xffff]) {
      assert.equal(decodeMdc(encodeMdc(0x01, 0x80, id, FS), FS)[0]?.unitId, id, `ID ${id}`);
    }
  });
});

describe('不该出帧的情况', () => {
  const rng = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296 - 0.5;
    };
  };

  it('纯噪声不出帧', () => {
    const r = rng(7);
    const noise = Float64Array.from({ length: FS * 3 }, () => r() * 8000);
    assert.deepEqual(decodeMdc(noise, FS), []);
  });

  it('单音不出帧', () => {
    const tone = Float64Array.from({ length: FS }, (_, i) =>
      8000 * Math.sin((2 * Math.PI * 1500 * i) / FS),
    );
    assert.deepEqual(decodeMdc(tone, FS), []);
  });

  it('CRC 被破坏就丢帧，不靠纠错捞回来', () => {
    const audio = encodeMdc(0x01, 0x80, ID, FS);
    // 把同步字之后的一整段比特抹平，CRC 必然不过
    const spb = FS / 1200;
    const from = Math.round((24 + 40 + 20) * spb);
    for (let i = from; i < from + spb * 12 && i < audio.length; i++) audio[i] = 0;
    for (const f of decodeMdc(audio, FS)) assert.notEqual(f.unitId, ID);
  });

  it('叠了噪声还能解，信噪比没那么脆', () => {
    const r = rng(11);
    const audio = Float64Array.from(encodeMdc(0x01, 0x80, ID, FS), (v) => v + r() * 3000);
    assert.equal(decodeMdc(audio, FS)[0]?.unitId, ID);
  });
});
