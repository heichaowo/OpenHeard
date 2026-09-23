import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Activity } from './core.ts';
import { SquelchDetector, bandEnergyDb } from './detector.ts';
import { decodeMdc } from './mdc.ts';

export interface AnalogConfig {
  /** 守哪个频率，Hz。一次只能守一个。 */
  freqHz: number;
  /** 信道名，进 Activity。 */
  channel: string;
  /** 调谐器增益，dB。 */
  gainDb: number;
  /** rtl_fm 输出的音频采样率。 */
  sampleRate: number;
  /** 判决块长，秒。 */
  blockS: number;
  /** 开机先听多久建立静默基准。 */
  calibrateS: number;
  /** 比静默基准低这么多算载波来了。实测落差 27 dB 以上，留足余量。 */
  openMarginDb: number;
  /** 回到基准以下这么多算还没走，和上面之间是迟滞。 */
  closeMarginDb: number;
  minDurationS: number;
  /** 本台的 MDC-1200 unit ID。解出它就说明这次发射是自己。缺省不判。 */
  myUnitId?: number;
  /** 静噪打开前留多少秒。MDC 的 BOT 突发在按下 PTT 后 30 ms 就发完，
   *  而静噪要一两块音频才判得出来，不留前导就只剩 EOT 可解。 */
  prerollS: number;
  /** 每次发射的音频往这里写，留给以后的语音识别。空字符串就不写。 */
  recordingsDir: string;
  rtlFmPath: string;
}

const NOISE_LO = 5000;
const NOISE_HI = 9000;

/** 幂等键要能重算，所以从信道和起始时刻推，不用随机数。 */
const eventId = (channel: string, startAt: number) =>
  'fm-' + createHash('sha1').update(`${channel}|${startAt.toFixed(2)}`).digest('hex').slice(0, 16);

function wav(pcm: Int16Array, sampleRate: number): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length * 2, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length * 2, 40);
  const body = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) body.writeInt16LE(pcm[i]!, i * 2);
  return Buffer.concat([head, body]);
}

/**
 * 守一个模拟信道，把静噪开启变成发射事件。
 *
 * 解调交给 rtl_fm，这里只在它输出的音频上做判决。
 * 门限不写死：开机先听一段静默，用它的高分位当基准，再按余量推出门限。
 * 各地噪声本底不同，写死一个常数等于把部署配置烤进代码。
 */
/**
 * 电台此刻的样子。每秒报一次，只放在内存里，不入库。
 *
 * 这些数原来只打到日志文件里，于是「天线听不见」和「没人在发」这两件事，
 * 在界面上长得一模一样，要分开只能登录到机器上看日志。
 */
export interface RadioStatus {
  freqMhz: number;
  channel: string;
  gainDb: number;
  /** 开机校准出来的静默基准，dB。 */
  idleDb?: number;
  /** 低于它算静噪打开。 */
  openBelowDb?: number;
  /** 高于它算关。 */
  closeAboveDb?: number;
  /** 此刻 5–9 kHz 的能量。有载波时会塌下去。 */
  noiseDb?: number;
  /** 此刻静噪是不是开着。 */
  open: boolean;
  /** 最近一次静噪打开的时刻，Unix 秒 UTC。 */
  lastOpenAt?: number;
  at: number;
}

/** 电台状态往外报的间隔。比 50 毫秒一块稀疏得多，够看就行。 */
const STATUS_MS = 1000;

const round1 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);

export function watchAnalog(
  cfg: AnalogConfig,
  onEvent: (activity: Activity, audio: Buffer) => void,
  onExit?: () => void,
  onStatus?: (s: RadioStatus) => void,
): { stop: () => void; lastError: () => string | undefined } {
  const blockN = Math.round(cfg.sampleRate * cfg.blockS);
  let idleDb: number | undefined;
  let lastOpenAt: number | undefined;
  let lastStatus = 0;
  let lastError: string | undefined;
  const child = spawn(cfg.rtlFmPath, [
    '-f', String(cfg.freqHz),
    '-M', 'fm',
    '-s', String(cfg.sampleRate),
    '-g', String(cfg.gainDb),
    '-',
  ]);

  if (cfg.recordingsDir) mkdirSync(cfg.recordingsDir, { recursive: true });

  let pending: Buffer = Buffer.alloc(0);
  let blockIndex = 0;
  const startedAt = Date.now() / 1000;
  const calibration: number[] = [];
  let detector: SquelchDetector | undefined;
  let captured: number[] = [];
  const prerollN = Math.round(cfg.sampleRate * cfg.prerollS);
  let preroll: number[] = [];

  child.stderr.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) {
      lastError = line;
      console.error(`rtl_fm: ${line}`);
    }
  });

  child.stdout.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

    while (pending.length >= blockN * 2) {
      const raw = pending.subarray(0, blockN * 2);
      pending = pending.subarray(blockN * 2);
      const pcm = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
      const samples = Array.from(pcm);
      const at = startedAt + blockIndex * cfg.blockS;
      blockIndex += 1;

      if (!detector) {
        calibration.push(bandEnergyDb(samples, cfg.sampleRate, NOISE_LO, NOISE_HI));
        // 校准这 5 秒里也要报。不报的话换频率之后界面上还挂着旧频率，
        // 而且 5 秒短于「太久没报」的门限，连不新鲜都看不出来。
        if (onStatus !== undefined && Date.now() - lastStatus >= STATUS_MS) {
          lastStatus = Date.now();
          onStatus({
            freqMhz: cfg.freqHz / 1e6,
            channel: cfg.channel,
            gainDb: cfg.gainDb,
            open: false,
            at: Math.round(Date.now() / 1000),
          });
        }
        if (calibration.length * cfg.blockS < cfg.calibrateS) continue;
        const sorted = [...calibration].sort((a, b) => a - b);
        const idle = sorted[Math.floor(sorted.length * 0.9)]!;
        idleDb = idle;
        detector = new SquelchDetector({
          sampleRate: cfg.sampleRate,
          openBelowDb: idle - cfg.openMarginDb,
          closeAboveDb: idle - cfg.closeMarginDb,
          minDurationS: cfg.minDurationS,
        });
        console.log(
          `静默基准 ${idle.toFixed(1)} dB，门限 开<${(idle - cfg.openMarginDb).toFixed(1)} 关>${(idle - cfg.closeMarginDb).toFixed(1)}`,
        );
        continue;
      }

      const wasOpen = detector.isOpen;
      const event = detector.push(samples, at, cfg.blockS);
      if (!wasOpen && detector.isOpen) lastOpenAt = Math.round(at);

      if (onStatus !== undefined && Date.now() - lastStatus >= STATUS_MS) {
        lastStatus = Date.now();
        onStatus({
          freqMhz: cfg.freqHz / 1e6,
          channel: cfg.channel,
          gainDb: cfg.gainDb,
          // 留一位小数。这是个分贝读数，后面十几位没有意义，只会让接口难读。
          idleDb: round1(idleDb),
          openBelowDb: idleDb === undefined ? undefined : round1(idleDb - cfg.openMarginDb),
          closeAboveDb: idleDb === undefined ? undefined : round1(idleDb - cfg.closeMarginDb),
          noiseDb: round1(bandEnergyDb(samples, cfg.sampleRate, NOISE_LO, NOISE_HI)),
          open: detector.isOpen,
          lastOpenAt,
          at: Math.round(Date.now() / 1000),
        });
      }

      if (!detector.isOpen) {
        for (const v of samples) preroll.push(v);
        if (preroll.length > prerollN) preroll = preroll.slice(preroll.length - prerollN);
      } else {
        if (!wasOpen) {
          captured = preroll;
          preroll = [];
        }
        for (const v of samples) captured.push(v);
      }

      // 事件太短会被丢掉，那时 event 是 undefined，但音频照样要清掉，
      // 否则它会串进下一次发射。所以按状态翻转清，不按有没有事件清。
      const closedNow = wasOpen && !detector.isOpen;
      const audio = closedNow ? Int16Array.from(captured) : undefined;
      if (closedNow) captured = [];

      if (event && audio) {
        // 只有 CRC 通过且 unit ID 相等才算本台。op 和 arg 不参与判定。
        const frames = cfg.myUnitId === undefined ? [] : decodeMdc(audio, cfg.sampleRate);
        const mine = frames.some((f) => f.unitId === cfg.myUnitId);
        if (frames.length > 0) {
          const list = frames
            .map(
              (f) =>
                `${f.unitId.toString(16).toUpperCase().padStart(4, '0')}` +
                `/${f.arg === 0x80 ? 'BOT' : f.arg === 0x00 ? 'EOT' : `arg${f.arg}`}` +
                `@${(f.atSample / cfg.sampleRate).toFixed(2)}s`,
            )
            .join(' ');
          console.log(`解出 ${frames.length} 个 MDC 帧: ${list}`);
        }

        const activity: Activity = {
          id: eventId(cfg.channel, event.startAt),
          origin: 'sdr-fm',
          startAt: Math.round(event.startAt),
          durationS: Number(event.durationS.toFixed(2)),
          mine,
          freqMhz: cfg.freqHz / 1e6,
          channel: cfg.channel,
          audioSnrDb: Number(event.audioSnrDb.toFixed(1)),
        };
        const buf = wav(audio, cfg.sampleRate);
        if (cfg.recordingsDir) {
          writeFileSync(join(cfg.recordingsDir, `${activity.id}.wav`), buf);
        }
        onEvent(activity, buf);
      }
    }
  });

  let stopped = false;
  child.on('exit', (code) => {
    console.error(`rtl_fm 退出，code ${code}`);
    if (!stopped) onExit?.();
  });

  return {
    stop() {
      stopped = true;
      const last = detector?.flush();
      if (last) console.error(`收尾时还有一次未闭合的发射，时长 ${last.durationS.toFixed(2)} 秒`);
      child.kill();
    },
    lastError: () => lastError,
  };
}
