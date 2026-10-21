/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Preferences } from '../Preferences'
import { TimeHeader } from './TimeHeader'

afterEach(() => localStorage.removeItem('openheard.zone'))

const mount = (zone: string) => {
  localStorage.setItem('openheard.zone', zone)
  return render(
    <Preferences>
      <TimeHeader />
    </Preferences>,
  )
}

// 偏移在时区名后面。截成省略号的话，名字长一点的时区（伦敦、洛杉矶）偏移就看不见了。
describe('TimeHeader', () => {
  it('长时区名：偏移在文字里，没有被截掉', () => {
    for (const zone of ['Europe/London', 'America/Los_Angeles']) {
      const { container, unmount } = mount(zone)
      expect(container.querySelector('.time-header-zone')).toHaveTextContent(new RegExp(`^${zone} UTC[+-]\\d\\d:\\d\\d$`))
      unmount()
    }
  })

  it('斜杠后面可以断行，文字本身不变', () => {
    const { container } = mount('America/Los_Angeles')
    const zone = container.querySelector('.time-header-zone')!
    expect(zone.querySelectorAll('wbr')).toHaveLength(1)
    expect(zone.textContent).toMatch(/^America\/Los_Angeles UTC/)
  })

  it('完整的写在悬停提示里', () => {
    const { container } = mount('Europe/London')
    expect(container.querySelector('.time-header')).toHaveAttribute('title', expect.stringMatching(/^时间 Europe\/London UTC/))
  })

  // jsdom 不排版，量不出换行，只能看样式表：不能 nowrap，也不能省略号。
  it('样式表：时区这一行换行，不截断', () => {
    // vitest 把样式表导成空串，所以直接读文件。
    const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8')
    const rule = /\.time-header-zone\s*\{([^}]*)\}/.exec(css)![1]!
    expect(rule).not.toMatch(/text-overflow/)
    expect(rule).not.toMatch(/nowrap/)
    expect(rule).toMatch(/white-space:\s*normal/)
  })
})
