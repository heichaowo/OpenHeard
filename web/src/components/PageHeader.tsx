import { Flex, Typography } from 'antd'
import type { ReactNode } from 'react'

/** 每页顶上的标题、一句说明和右侧动作。 */
export function PageHeader({
  title,
  note,
  actions,
}: {
  title: ReactNode
  note?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="page-head">
      <div>
        <Typography.Title level={1}>{title}</Typography.Title>
        {note && <div className="page-note">{note}</div>}
      </div>
      {actions && (
        <Flex className="page-head-actions" align="center">
          {actions}
        </Flex>
      )}
    </div>
  )
}
