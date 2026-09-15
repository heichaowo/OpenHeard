import { ReloadOutlined } from '@ant-design/icons'
import { Button, Empty, Result, Skeleton } from 'antd'
import type { ReactNode } from 'react'

interface Props {
  loading: boolean
  /** 后端回的那句话，正常是 undefined。 */
  error?: string
  /** 拿到数据了但一条都没有。 */
  empty?: boolean
  emptyText?: string
  onRetry: () => void
  children: ReactNode
}

/**
 * 加载、出错、空三态的外壳。
 *
 * 顺序是有意的：加载优先于出错，出错优先于空。
 * 反过来会在首屏还没拿到数据时先闪一下空状态。
 */
export function AsyncContent({ loading, error, empty, emptyText, onRetry, children }: Props) {
  if (loading) {
    return (
      <div className="state-box">
        <Skeleton active paragraph={{ rows: 4 }} />
      </div>
    )
  }

  if (error) {
    return (
      <Result
        status="warning"
        title="拿不到数据"
        subTitle={error}
        extra={
          <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
            重试
          </Button>
        }
      />
    )
  }

  if (empty) {
    return (
      <div className="state-box">
        <Empty description={emptyText ?? '还没有内容'} />
      </div>
    )
  }

  return children
}
