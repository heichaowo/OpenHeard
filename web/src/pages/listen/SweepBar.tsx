import { Button, Popconfirm } from 'antd'
import type { ConversationPick } from '../../api'
import { SnapConfirm } from './SnapConfirm'

/**
 * 批量忽略、批量删除工具条。待确认和未入库两档共用：数字侧一大半是一两秒的空按，
 * 一条一条点忽略没人受得了。删除确认框打开那一刻抄下选中的那几次，确认后只删这些。
 */
export function SweepBar({
  total,
  aloneCount,
  pickedCount,
  clearing,
  onPickShort,
  onPickAlone,
  onClear,
  onSweep,
  picks,
  onDelete,
  onConfirmOpen,
}: {
  total: number
  aloneCount: number
  pickedCount: number
  clearing: boolean
  onPickShort: () => void
  onPickAlone: () => void
  onClear: () => void
  onSweep: () => void
  /** 此刻选中的那几段，各带挑中的发射。 */
  picks: () => ConversationPick[]
  onDelete: (snapshot: ConversationPick[]) => void | Promise<void>
  onConfirmOpen: (id: string, open: boolean) => void
}) {
  if (total === 0) return null
  return (
    <div className="sweep-bar">
      <Button size="small" onClick={onPickShort}>
        选中只按了一下的
      </Button>
      <Button size="small" onClick={onPickAlone} disabled={aloneCount === 0}>
        选中没人回的（{aloneCount}）
      </Button>
      <Button size="small" onClick={onClear} disabled={pickedCount === 0}>
        取消选中
      </Button>
      <Popconfirm title={`忽略选中的 ${pickedCount} 段？`} onConfirm={onSweep} disabled={pickedCount === 0}>
        <Button size="small" danger loading={clearing} disabled={pickedCount === 0}>
          忽略选中（{pickedCount}）
        </Button>
      </Popconfirm>
      <SnapConfirm
        id="delete:sweep"
        picks={picks}
        title={(snap) => `删掉选中的 ${snap.length} 段？`}
        description="连同录音删掉，删了找不回来。"
        disabled={pickedCount === 0}
        onConfirm={onDelete}
        onOpenChange={onConfirmOpen}
      >
        <Button size="small" danger loading={clearing} disabled={pickedCount === 0}>
          删除选中（{pickedCount}）
        </Button>
      </SnapConfirm>
    </div>
  )
}
