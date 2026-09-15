// MDC-1200 解码。用来判断一次模拟发射是不是本台。
//
// 自己写是因为没有能用的现成实现：Kaufman 那套 C 代码及其全部衍生是
// GPL-2.0-only，AGPL-3.0 吸收不了；SDRTrunk 相容但耦合在自己的 DSP 框架里；
// TypeScript 的实现不存在。帧格式写在 specs/openheard.md。

export interface MdcFrame {
  op: number;
  arg: number;
  unitId: number;
  /** 突发在音频里的位置，用来判断它落在发射的头还是尾。 */
  atSample: number;
}

const BAUD = 1200;
const MARK = 1200;
const SPACE = 1800;
const SYNC = [0x07, 0x09, 0x2a, 0x44, 0x6f];
/** 40 位里允许错几位。同步字本身没有纠错，留一点余量。 */
const SYNC_TOLERANCE = 5;
const PAYLOAD_BITS = 112;

/**
 * CRC-16，只覆盖前 4 字节。
 *
 * 多项式 0x1021，初值 0，输入输出都反转，最后异或 0xFFFF。
 * 它对不上任何一个有名字的变体，别去套标准名。
 */
export function mdcCrc(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) {
    const c = flip(b, 8);
    for (let mask = 0x80; mask > 0; mask >>= 1) {
      let carry = crc & 0x8000;
      crc = (crc << 1) & 0xffff;
      if (c & mask) carry ^= 0x8000;
      if (carry) crc ^= 0x1021;
    }
  }
  return (flip(crc, 16) ^ 0xffff) & 0xffff;
}

function flip(x: number, n: number): number {
  let out = 0;
  for (let i = 0; i < n; i++) if (x & (1 << i)) out |= 1 << (n - 1 - i);
  return out;
}

const bitsMsb = (bytes: number[]): number[] =>
  bytes.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >> i) & 1));

/** 交织矩阵是 16 列 7 行。两端的比特序不同，写成同一个方向就永远对不上 CRC。 */
export function deinterleave(air: number[]): number[] {
  const o = bitsMsb(air);
  const src: number[] = [];
  for (let i = 0; i < PAYLOAD_BITS; i++) src.push(o[(i % 7) * 16 + Math.floor(i / 7)]!);
  const out: number[] = [];
  for (let i = 0; i < 14; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) if (src[i * 8 + j]) b |= 1 << j; // 出口 LSB 先
    out.push(b);
  }
  return out;
}

/** deinterleave 的逆。只给测试用，用来造合成帧。 */
export function interleave(flat: number[]): number[] {
  const src: number[] = [];
  for (let i = 0; i < 14; i++) for (let j = 0; j < 8; j++) src.push((flat[i]! >> j) & 1);
  const o: number[] = new Array(PAYLOAD_BITS).fill(0);
  for (let i = 0; i < PAYLOAD_BITS; i++) o[(i % 7) * 16 + Math.floor(i / 7)] = src[i]!;
  const out: number[] = [];
  for (let i = 0; i < 14; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) if (o[i * 8 + j]) b |= 1 << (7 - j);
    out.push(b);
  }
  return out;
}

/** R=1/2、K=7 的系统卷积码，抽头 0、2、5、6。只用来造合成帧，解码端不纠错。 */
export function fecBytes(msg: number[]): number[] {
  const csr = [0, 0, 0, 0, 0, 0, 0];
  const out: number[] = [];
  for (let i = 0; i < 7; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      csr.pop();
      csr.unshift((msg[i]! >> j) & 1);
      if (csr[0]! ^ csr[2]! ^ csr[5]! ^ csr[6]!) b |= 1 << j;
    }
    out.push(b);
  }
  return out;
}

function goertzel(x: ArrayLike<number>, start: number, n: number, freq: number, fs: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * ((freq * n) / fs)) / n);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = (x[start + i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

const matches = (bits: number[], at: number, want: number[]) => {
  let bad = 0;
  for (let i = 0; i < want.length; i++) if (bits[at + i] !== want[i]) bad += 1;
  return bad;
};

/**
 * 从一段音频里找出全部 MDC 帧。
 *
 * 前导码长度不是协议常数，所以不靠它做时序假设，只做同步字滑动相关。
 * 比特相位未知，所以把每个采样偏移都试一遍；极性也有二义，同步字和它的
 * 取反版都要匹配。CRC 不过直接丢，不做纠错。
 */
export function decodeMdc(audio: ArrayLike<number>, sampleRate: number): MdcFrame[] {
  const spb = Math.round(sampleRate / BAUD);
  const syncBits = bitsMsb(SYNC);
  const syncInv = syncBits.map((b) => b ^ 1);
  const frames: MdcFrame[] = [];

  for (let phase = 0; phase < spb; phase++) {
    const raw: number[] = [];
    for (let s = phase; s + spb <= audio.length; s += spb) {
      const mark = goertzel(audio, s, spb, MARK, sampleRate);
      const space = goertzel(audio, s, spb, SPACE, sampleRate);
      raw.push(space > mark ? 1 : 0);
    }

    // 差分解码要在找同步字之前做。空中比特是「变了没有」，不是消息位本身。
    const msg: number[] = [];
    let prev = 0;
    for (const r of raw) {
      prev ^= r;
      msg.push(prev);
    }

    for (let i = 0; i + 40 + PAYLOAD_BITS <= msg.length; i++) {
      const straight = matches(msg, i, syncBits);
      const inverted = matches(msg, i, syncInv);
      if (Math.min(straight, inverted) > SYNC_TOLERANCE) continue;
      const flipAll = inverted < straight;

      const air: number[] = [];
      for (let b = 0; b < 14; b++) {
        let byte = 0;
        for (let k = 0; k < 8; k++) {
          const bit = msg[i + 40 + b * 8 + k]! ^ (flipAll ? 1 : 0);
          if (bit) byte |= 1 << (7 - k);
        }
        air.push(byte);
      }

      const flat = deinterleave(air);
      const [op, arg, idHi, idLo, crcLo, crcHi] = flat as [number, number, number, number, number, number];
      // ID 大端，CRC 小端，同一个 7 字节里两种字节序。
      if (mdcCrc([op, arg, idHi, idLo]) !== ((crcHi << 8) | crcLo)) continue;

      frames.push({ op, arg, unitId: (idHi << 8) | idLo, atSample: phase + i * spb });
    }
  }

  // 同一个突发会被多个采样相位各解出一次，按位置去重。
  // 一帧本身占 152 位，所以同 ID 且相距不到这个长度的一定是同一次。
  const window = PAYLOAD_BITS * spb;
  const out: MdcFrame[] = [];
  for (const f of frames.sort((a, b) => a.atSample - b.atSample)) {
    if (out.some((k) => k.unitId === f.unitId && f.atSample - k.atSample < window)) continue;
    out.push(f);
  }
  return out;
}

/** 造一段合成的 MDC 突发。只给测试用。 */
export function encodeMdc(
  op: number,
  arg: number,
  unitId: number,
  sampleRate: number,
  preambleBits = 24,
): Float64Array {
  const crc = mdcCrc([op, arg, unitId >> 8, unitId & 0xff]);
  const msg = [op, arg, unitId >> 8, unitId & 0xff, crc & 0xff, crc >> 8, 0];
  const air = interleave([...msg, ...fecBytes(msg)]);

  const message = [...new Array<number>(preambleBits).fill(0), ...bitsMsb(SYNC), ...bitsMsb(air)];
  // 消息位转回空中位：raw[n] = msg[n] ^ msg[n-1]
  const raw: number[] = [];
  let prev = 0;
  for (const m of message) {
    raw.push(m ^ prev);
    prev = m;
  }

  const spb = Math.round(sampleRate / BAUD);
  const out = new Float64Array(raw.length * spb);
  let phase = 0;
  for (let b = 0; b < raw.length; b++) {
    const f = raw[b] ? SPACE : MARK;
    for (let i = 0; i < spb; i++) {
      out[b * spb + i] = 8000 * Math.sin(phase);
      phase += (2 * Math.PI * f) / sampleRate; // 相位连续，不在比特边界复位
    }
  }
  return out;
}
