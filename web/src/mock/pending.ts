// 假数据，等后端接上就整个删掉。
// 队列只装含有本台的对话，过滤在上游做，这里的每条都已经含本台。

import type { Cluster, Mode, Qso, StationDefaults } from '@core'

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000)

export const STATION: StationDefaults = {
  myGridsquare: 'OM24',
  myQth: '成都',
  myDevice: 'Quansheng UV-K6',
  myAntenna: 'Nagoya NA-771',
  myPower: '5W',
  myHeightM: 30,
  networkFreqMhz: 439.525,
}

export const MOCK_CLUSTERS: Cluster[] = [
  {
    // 模拟中继。机器只知道有人在说话，呼号一个都拿不到。
    id: 'c-20260913-2014',
    startAt: t('2026-09-13T20:14:32+08:00'),
    endAt: t('2026-09-13T20:15:18+08:00'),
    activities: [
      {
        id: 'a-1',
        origin: 'sdr-fm',
        startAt: t('2026-09-13T20:14:32+08:00'),
        durationS: 3.2,
        mine: false,
        freqMhz: 439.525,
        channel: '439.525 中继',
        audioSnrDb: 18.4,
      },
      {
        id: 'a-2',
        origin: 'sdr-fm',
        startAt: t('2026-09-13T20:14:41+08:00'),
        durationS: 6.8,
        mine: true,
        freqMhz: 439.525,
        channel: '439.525 中继',
        audioSnrDb: 26.1,
      },
      {
        id: 'a-3',
        origin: 'sdr-fm',
        startAt: t('2026-09-13T20:14:52+08:00'),
        durationS: 12.4,
        mine: false,
        freqMhz: 439.525,
        channel: '439.525 中继',
        audioSnrDb: 12.7,
      },
      {
        id: 'a-4',
        origin: 'sdr-fm',
        startAt: t('2026-09-13T20:15:09+08:00'),
        durationS: 9.1,
        mine: true,
        freqMhz: 439.525,
        channel: '439.525 中继',
        audioSnrDb: 25.8,
      },
    ],
  },
  {
    // BrandMeister。对方呼号来自话务组查询，只查 src_<DMRID> 是拿不到的。
    id: 'c-20260913-2102',
    startAt: t('2026-09-13T21:02:10+08:00'),
    endAt: t('2026-09-13T21:03:41+08:00'),
    activities: [
      {
        id: 'a-5',
        origin: 'brandmeister',
        startAt: t('2026-09-13T21:02:10+08:00'),
        durationS: 14.6,
        mine: true,
        callsign: 'BG0CG',
        dmrId: 4600123,
        talkgroup: 46001,
        ber: 0,
      },
      {
        id: 'a-6',
        origin: 'brandmeister',
        startAt: t('2026-09-13T21:02:36+08:00'),
        durationS: 22.3,
        mine: false,
        callsign: 'BD7KLO',
        dmrId: 4604567,
        talkgroup: 46001,
        ber: 0.2,
      },
      {
        id: 'a-7',
        origin: 'brandmeister',
        startAt: t('2026-09-13T21:03:08+08:00'),
        durationS: 18.9,
        mine: true,
        callsign: 'BG0CG',
        dmrId: 4600123,
        talkgroup: 46001,
        ber: 0,
      },
    ],
  },
  {
    // 直频。两边都在本地，信号报告两项都可以推，但阈值还没实测。
    id: 'c-20260913-2230',
    startAt: t('2026-09-13T22:30:04+08:00'),
    endAt: t('2026-09-13T22:30:29+08:00'),
    activities: [
      {
        id: 'a-8',
        origin: 'sdr-fm',
        startAt: t('2026-09-13T22:30:04+08:00'),
        durationS: 8.5,
        mine: true,
        freqMhz: 145.5,
        channel: '145.500 直频',
        rssi: -62,
        audioSnrDb: 28.0,
      },
      {
        id: 'a-9',
        origin: 'sdr-fm',
        startAt: t('2026-09-13T22:30:16+08:00'),
        durationS: 13.2,
        mine: false,
        freqMhz: 145.5,
        channel: '145.500 直频',
        rssi: -89,
        audioSnrDb: 9.3,
      },
    ],
  },
]

/** 部署配置里的频谱表，现在先写死几条。 */
export const CHANNELS: { name: string; freqMhz: number; mode: Mode }[] = [
  { name: '439.525 中继', freqMhz: 439.525, mode: 'FM' },
  { name: '145.500 直频', freqMhz: 145.5, mode: 'FM' },
  { name: 'BrandMeister TG 46001', freqMhz: 439.525, mode: 'DMR' },
]

const qso = (
  id: string,
  call: string,
  iso: string,
  freqMhz: number,
  band: string,
  mode: Mode,
  over: Partial<Qso> = {},
): Qso => ({
  id,
  call,
  startAt: t(iso),
  freqMhz,
  band,
  mode,
  rstSent: '59',
  rstRcvd: '59',
  myGridsquare: STATION.myGridsquare,
  myQth: STATION.myQth,
  myDevice: STATION.myDevice,
  myAntenna: STATION.myAntenna,
  myPower: STATION.myPower,
  myHeightM: STATION.myHeightM,
  createdAt: t(iso),
  ...over,
})

export const MOCK_QSOS: Qso[] = [
  qso('q1', 'BG8FBC', '2026-09-12T11:04:00Z', 439.525, '70cm', 'FM', {
    clusterId: 'c-20260912-1104',
    qth: '成都',
    rstRcvd: '57',
  }),
  qso('q2', 'BD7KLO', '2026-09-11T13:22:00Z', 439.525, '70cm', 'DMR', {
    clusterId: 'c-20260911-1322',
    gridsquare: 'OL72',
    qth: '深圳',
  }),
  qso('q3', 'BA1AA', '2026-09-10T02:15:00Z', 145.5, '2m', 'FM', {
    rstSent: '55',
    rstRcvd: '53',
    note: '手工补录，当时没开采集',
  }),
  qso('q4', 'JA1XYZ', '2026-09-09T09:41:00Z', 439.525, '70cm', 'DMR', {
    clusterId: 'c-20260909-0941',
    gridsquare: 'PM95',
  }),
  qso('q5', 'BG0CG/P', '2026-09-08T23:58:00Z', 145.5, '2m', 'FM', {
    note: '龙泉山顶便携',
    myHeightM: 1051,
  }),
]
