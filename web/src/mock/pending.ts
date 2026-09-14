// 假数据，等后端接上就整个删掉。
// 队列只装含有本台的对话，过滤在上游做，这里的每条都已经含本台。

import type { Cluster, StationDefaults } from '@core'

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
