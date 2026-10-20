import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Popconfirm } from 'antd'
import type { ConversationPick } from '../../api'

/**
 * 删除、忽略的确认框。打开那一刻把要动的那几次发射抄下来，确认框上写的数和确认后
 * 送出去的，都是抄下来的这份。确认框开着的时候回复进来、行里的成员涨了，
 * 那几次没人看过，不能跟着一起删掉（和抽屉、批量忽略认「看过的那几次」是同一个道理）。
 *
 * onOpenChange 把开关报给页面：确认框开着时列表不能动。行被换成新 id 重建、确认框跟着
 * 没了的时候，卸载时补报一次关，不然页面会一直当它开着。
 */
export function SnapConfirm({
  id,
  picks,
  title,
  description,
  disabled,
  onConfirm,
  onOpenChange,
  children,
}: {
  /** 页面里区分各个确认框的名字。 */
  id: string
  /** 此刻要动哪几次，打开确认框时取一次。 */
  picks: () => ConversationPick[]
  title: (snapshot: ConversationPick[]) => ReactNode
  description?: ReactNode
  disabled?: boolean
  onConfirm: (snapshot: ConversationPick[]) => void | Promise<void>
  onOpenChange: (id: string, open: boolean) => void
  children: ReactElement
}) {
  const [snap, setSnap] = useState<ConversationPick[] | null>(null)
  const report = useRef(onOpenChange)
  useEffect(() => {
    report.current = onOpenChange
  })
  useEffect(() => () => report.current(id, false), [id])

  return (
    <Popconfirm
      title={title(snap ?? picks())}
      description={description}
      disabled={disabled}
      onOpenChange={(open) => {
        setSnap(open ? picks() : null)
        onOpenChange(id, open)
      }}
      onConfirm={() => onConfirm(snap ?? picks())}
    >
      {children}
    </Popconfirm>
  )
}
