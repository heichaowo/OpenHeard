import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AsyncContent } from './AsyncContent'

describe('AsyncContent', () => {
  it('加载中：电波纹加载态，不是骨架屏', () => {
    render(
      <AsyncContent loading error={undefined} onRetry={vi.fn()}>
        <p>内容</p>
      </AsyncContent>,
    )
    expect(screen.getByRole('status', { name: '加载中' })).toBeInTheDocument()
    expect(screen.queryByText('内容')).not.toBeInTheDocument()
  })

  it('出错且手上没有数据：整页报错，带重试', async () => {
    const onRetry = vi.fn()
    render(
      <AsyncContent loading={false} error="连不上" empty onRetry={onRetry}>
        <p>内容</p>
      </AsyncContent>,
    )
    expect(screen.getByText('连不上')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('出错但手上有数据：横幅提示，内容照旧显示', () => {
    render(
      <AsyncContent loading={false} error="连不上" empty={false} onRetry={vi.fn()}>
        <p>内容</p>
      </AsyncContent>,
    )
    expect(screen.getByText(/刷新失败/)).toBeInTheDocument()
    expect(screen.getByText('内容')).toBeInTheDocument()
  })

  it('没出错但一条都没有：空状态', () => {
    render(
      <AsyncContent loading={false} error={undefined} empty emptyText="队列空了" onRetry={vi.fn()}>
        <p>内容</p>
      </AsyncContent>,
    )
    expect(screen.getByText('队列空了')).toBeInTheDocument()
  })

  it('正常：直接渲染内容', () => {
    render(
      <AsyncContent loading={false} error={undefined} empty={false} onRetry={vi.fn()}>
        <p>内容</p>
      </AsyncContent>,
    )
    expect(screen.getByText('内容')).toBeInTheDocument()
  })
})
