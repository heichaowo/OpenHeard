import type { QsoField } from '@core'

/** 缺字段时报给人的名字。两个抽屉用同一份，否则同一个错在两处说法不同。 */
export const FIELD_LABELS: Partial<Record<QsoField, string>> = {
  call: '对方呼号',
  startAt: '时间',
  freqMhz: '频率',
  band: '波段',
  mode: '模式',
  rstSent: '发出报告',
  rstRcvd: '收到报告',
}
