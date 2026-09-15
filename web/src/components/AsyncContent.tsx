import { ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Empty, Result, Skeleton } from 'antd'
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

  // 手上一条数据都没有时才整页报错。已经在渲染的表格不能被一次轮询失败盖掉，
  // 那会连带丢掉展开行、分页和筛选，而下一次轮询多半自己就好了。
  if (error && empty) {
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

  if (error) {
    return (
      <>
        <Alert
          type="warning"
          banner
          message={`刷新失败，下面是上一次拿到的内容。${error}`}
          action={
            <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRetry}>
              重试
            </Button>
          }
        />
        {children}
      </>
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
