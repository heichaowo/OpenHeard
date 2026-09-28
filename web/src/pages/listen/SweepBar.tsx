import { Button, Popconfirm } from 'antd'

/**
 * 批量忽略工具条。待确认和未入库两档共用：数字侧一大半是一两秒的空按，
 * 一条一条点忽略没人受得了。
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
}: {
  total: number
  aloneCount: number
  pickedCount: number
  clearing: boolean
  onPickShort: () => void
  onPickAlone: () => void
  onClear: () => void
  onSweep: () => void
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
    </div>
  )
}
