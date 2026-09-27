import { describe, expect, it } from 'vitest'
import { formatDuration, playingLabel } from './duration'

describe('formatDuration', () => {
  it('10 秒以内留一位小数', () => {
    expect(formatDuration(3.2)).toBe('3.2 秒')
    expect(formatDuration(0)).toBe('0.0 秒')
  })

  it('10 秒到一分钟之间取整秒', () => {
    expect(formatDuration(10)).toBe('10 秒')
    expect(formatDuration(12.4)).toBe('12 秒')
    expect(formatDuration(59.6)).toBe('1 分 00 秒')
  })

  it('一分钟以上写成「N 分 SS 秒」，秒数两位补零', () => {
    expect(formatDuration(65)).toBe('1 分 05 秒')
    expect(formatDuration(60)).toBe('1 分 00 秒')
    expect(formatDuration(3725)).toBe('62 分 05 秒')
  })
})

describe('playingLabel', () => {
  it('两边都不到一分钟时合用一个「秒」字', () => {
    expect(playingLabel(1.4, 3.6)).toBe('1.4 / 3.6 秒')
    expect(playingLabel(12, 45)).toBe('12 / 45 秒')
  })

  it('有一边到了一分钟，各自按 formatDuration 写全', () => {
    expect(playingLabel(65, 130)).toBe('1 分 05 秒 / 2 分 10 秒')
    expect(playingLabel(12, 65)).toBe('12 秒 / 1 分 05 秒')
  })
})
