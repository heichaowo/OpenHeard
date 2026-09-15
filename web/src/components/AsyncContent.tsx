// 取自 OpenLogTool Server，Copyright © 2026 Mazha0309 与贡献者，AGPL-3.0-only。
// 来源 https://github.com/Mazha0309/OpenLogToolServer （web/src/components/AsyncContent.tsx）
// 改动：去掉 i18n 和它的错误码分支，本项目的后端只回一条 error 字符串。
import { ReloadOutlined } from '@ant-design/icons'
import { Button, Empty, Result, Skeleton } from 'antd'
import type { ReactNode } from 'react'

export function AsyncContent({
  loading,
  error,
  empty,
  emptyText,
  onRetry,
  children,
}: {
  loading: boolean
  error?: string
  empty?: boolean
  emptyText?: string
  onRetry: () => void
  children: ReactNode
}) {
  if (loading) {
    return (
      <div className="empty-state">
        <Skeleton active paragraph={{ rows: 5 }} />
      </div>
    )
  }
  if (error) {
    return (
      <Result
        status="error"
        title="拿不到数据"
        subTitle={error}
        extra={
          <Button icon={<ReloadOutlined />} onClick={onRetry}>
            重试
          </Button>
        }
      />
    )
  }
  if (empty) {
    return (
      <div className="empty-state">
        <Empty description={emptyText ?? '还没有内容'} />
      </div>
    )
  }
  return children
}
