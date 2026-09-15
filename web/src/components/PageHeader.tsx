// 取自 OpenLogTool Server，Copyright © 2026 Mazha0309 与贡献者，AGPL-3.0-only。
// 来源 https://github.com/Mazha0309/OpenLogToolServer （web/src/components/PageHeader.tsx）
import { Typography } from 'antd'
import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="page-header">
      <div>
        <Typography.Title level={1}>{title}</Typography.Title>
        {description && <div className="page-header-description">{description}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  )
}
