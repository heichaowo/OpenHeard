import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Activity } from './core.ts';
import { SquelchDetector } from './detector.ts';
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
  /** 静噪关着时每隔多久按最近这一段重定基准。 */
  trackS: number;
  /** 静噪开着超过这么久就强制关掉。录音缓冲也按它封顶。 */
  maxOpenS: number;
  /** 本台的 MDC-1200 unit ID。解出它就说明这次发射是自己。缺省不判。 */
  myUnitId?: number;
  /** 静噪打开前留多少秒。MDC 的 BOT 突发在按下 PTT 后 30 ms 就发完，
   *  而静噪要一两块音频才判得出来，不留前导就只剩 EOT 可解。 */
  prerollS: number;
  /** 每次发射的音频往这里写，留给以后的语音识别。空字符串就不写。 */
  recordingsDir: string;
  rtlFmPath: string;
}

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

/** 基准挪动这么多才记一行日志。每分钟都在微调，逐次记会淹掉别的。 */
const LOG_IDLE_STEP_DB = 3;

/**
 * 守一个模拟信道，把静噪开启变成发射事件。
 *
 * 解调交给 rtl_fm，这里只在它输出的音频上做判决。
 * 门限不写死：先听一段静默，用它的高分位当基准，再按余量推出门限。静噪关着时
 * 基准跟着本底走，见 SquelchDetector。
 */
export function watchAnalog(
  cfg: AnalogConfig,
  onEvent: (activity: Activity, audio: Buffer) => void,
  onExit?: () => void,
  onStatus?: (s: RadioStatus) => void,
): { stop: () => void; lastError: () => string | undefined } {
  const blockN = Math.round(cfg.sampleRate * cfg.blockS);
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
  const detector = new SquelchDetector({
    sampleRate: cfg.sampleRate,
    calibrateS: cfg.calibrateS,
    openMarginDb: cfg.openMarginDb,
    closeMarginDb: cfg.closeMarginDb,
    minDurationS: cfg.minDurationS,
    trackS: cfg.trackS,
    maxOpenS: cfg.maxOpenS,
  });
  let loggedIdle: number | undefined;

  // 静噪开着时的音频，按下标写，长度从结构上封死。以前是 number[] 一直 push，
  // 静噪卡住 93 分钟后撞上 V8 数组的上限，整个守护进程崩掉。探测器到 maxOpenS
  // 会强制关，这里再多留前导和一块的余量。
  const prerollN = Math.round(cfg.sampleRate * cfg.prerollS);
  const captured = new Int16Array(Math.ceil(cfg.sampleRate * cfg.maxOpenS) + prerollN + blockN);
  let capturedN = 0;
  const preroll = new Int16Array(prerollN);
  let prerollLen = 0;

  /** 静噪关着时只留最后 prerollN 个样点。 */
  const keep = (pcm: Int16Array) => {
    if (pcm.length >= prerollN) {
      preroll.set(pcm.subarray(pcm.length - prerollN));
      prerollLen = prerollN;
      return;
    }
    const drop = Math.max(0, prerollLen + pcm.length - prerollN);
    preroll.copyWithin(0, drop, prerollLen);
    prerollLen -= drop;
    preroll.set(pcm, prerollLen);
    prerollLen += pcm.length;
  };

  const capture = (pcm: Int16Array) => {
    const n = Math.min(pcm.length, captured.length - capturedN);
    captured.set(pcm.subarray(0, n), capturedN);
    capturedN += n;
  };

  // 每小时一行小结。「一整天没听到」要能从日志里查证，不能只靠没有记录。
  const hourBlocks = Math.round(3600 / cfg.blockS);
  const freshHour = () => ({
    blocks: 0,
    events: 0,
    closest: Infinity,
    idleLo: Infinity,
    idleHi: -Infinity,
    counts: { ...detector.counts },
  });
  let hour = freshHour();

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
      const at = startedAt + blockIndex * cfg.blockS;
      blockIndex += 1;

      const wasOpen = detector.isOpen;
      const calibrating = detector.idleDb === undefined;
      const openBelow = detector.openBelowDb;
      const event = detector.push(pcm, at, cfg.blockS);
      if (!wasOpen && detector.isOpen) lastOpenAt = Math.round(at);

      const idle = detector.idleDb;
      if (idle !== undefined && loggedIdle === undefined) {
        console.log(
          `静默基准 ${idle.toFixed(1)} dB，门限 开<${detector.openBelowDb!.toFixed(1)} 关>${detector.closeAboveDb!.toFixed(1)}`,
        );
        loggedIdle = idle;
      } else if (idle !== undefined && Math.abs(idle - loggedIdle!) >= LOG_IDLE_STEP_DB) {
        console.log(
          `基准跟着本底移到 ${idle.toFixed(1)} dB，门限 开<${detector.openBelowDb!.toFixed(1)} 关>${detector.closeAboveDb!.toFixed(1)}`,
        );
        loggedIdle = idle;
      }
      if (event?.forced) {
        console.error(
          `静噪开了 ${event.durationS.toFixed(0)} 秒没关，强制关掉，基准现在是 ${idle!.toFixed(1)} dB`,
        );
      }

      // 校准这 5 秒里也要报。不报的话换频率之后界面上还挂着旧频率，
      // 而且 5 秒短于「太久没报」的门限，连不新鲜都看不出来。
      if (onStatus !== undefined && Date.now() - lastStatus >= STATUS_MS) {
        lastStatus = Date.now();
        onStatus({
          freqMhz: cfg.freqHz / 1e6,
          channel: cfg.channel,
          gainDb: cfg.gainDb,
          // 留一位小数。这是个分贝读数，后面十几位没有意义，只会让接口难读。
          idleDb: round1(idle),
          openBelowDb: round1(detector.openBelowDb),
          closeAboveDb: round1(detector.closeAboveDb),
          noiseDb: calibrating ? undefined : round1(detector.noiseDb),
          open: detector.isOpen,
          lastOpenAt,
          at: Math.round(Date.now() / 1000),
        });
      }

      if (!calibrating) {
        hour.blocks += 1;
        if (!wasOpen && openBelow !== undefined) {
          hour.closest = Math.min(hour.closest, detector.noiseDb! - openBelow);
        }
        hour.idleLo = Math.min(hour.idleLo, idle!);
        hour.idleHi = Math.max(hour.idleHi, idle!);
        if (event) hour.events += 1;
        if (hour.blocks >= hourBlocks) {
          const c = detector.counts;
          const opened = c.opened - hour.counts.opened;
          console.log(
            `过去一小时 ${cfg.freqHz / 1e6} MHz：静噪开 ${opened} 次，记下 ${hour.events} 次，` +
              `太短没记 ${c.short - hour.counts.short} 次，强制关 ${c.forced - hour.counts.forced} 次。` +
              (hour.closest > 0 ? `噪声离开启门限最近还差 ${hour.closest.toFixed(1)} dB。` : '') +
              `基准 ${hour.idleLo.toFixed(1)} 到 ${hour.idleHi.toFixed(1)} dB`,
          );
          hour = freshHour();
        }
      }

      // 强制关掉的那一块还压着载波，属于这次发射，不是下一次的前导。
      if (!detector.isOpen && !event?.forced) {
        keep(pcm);
      } else {
        if (!wasOpen) {
          captured.set(preroll.subarray(0, prerollLen));
          capturedN = prerollLen;
          prerollLen = 0;
        }
        capture(pcm);
      }

      // 事件太短会被丢掉，那时 event 是 undefined，但音频照样要清掉，
      // 否则它会串进下一次发射。所以按状态翻转清，不按有没有事件清。
      const closedNow = wasOpen && !detector.isOpen;
      const audio = closedNow ? captured.slice(0, capturedN) : undefined;
      if (closedNow) capturedN = 0;

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
      const last = detector.flush();
      if (last) console.error(`收尾时还有一次未闭合的发射，时长 ${last.durationS.toFixed(2)} 秒`);
      child.kill();
    },
    lastError: () => lastError,
  };
}
