import { Button } from 'antd'
import type { ConversationPick } from '../../api'
import { SnapConfirm } from './SnapConfirm'

/**
 * 无意义档上方那一条：把已经加载出来的整批删掉。「已加载」是点按钮那一刻列表里有的，
 * 点「更早的」翻出来的也算；确认框开着时进来的行不算，确认后只删打开时抄下的那几段。
 */
export function PageDeleteBar({
  count,
  deleting,
  picks,
  onDelete,
  onConfirmOpen,
}: {
  count: number
  deleting: boolean
  picks: () => ConversationPick[]
  onDelete: (snapshot: ConversationPick[]) => void | Promise<void>
  onConfirmOpen: (id: string, open: boolean) => void
}) {
  if (count === 0) return null
  return (
    <div className="sweep-bar">
      <SnapConfirm
        id="delete:page"
        picks={picks}
        title={(snap) => `删掉已加载的 ${snap.length} 段？`}
        description="连同录音删掉，删了找不回来。"
        onConfirm={onDelete}
        onOpenChange={onConfirmOpen}
      >
        <Button size="small" danger loading={deleting}>
          删除已加载的 {count} 段
        </Button>
      </SnapConfirm>
    </div>
  )
}
