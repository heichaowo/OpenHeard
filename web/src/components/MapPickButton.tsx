import { Suspense, lazy, useState } from 'react'
import { Button, Form, Grid, Tooltip, Typography } from 'antd'
import type { NamePath } from 'antd/es/form/interface'
import { EnvironmentOutlined } from '@ant-design/icons'
import { useStore } from '../store'
import type { MapProvider } from '../api'

// 地图代码很重，点了按钮才下载。
const MapPicker = lazy(() => import('./MapPicker'))

const NO_MAP = '在设置里选一种地图'

/**
 * 「在地图上选」按钮，挂在 Form 里，直接读写网格和 QTH 那两格。
 * 没选地图时按钮禁用，原因写在旁边：手机上点一下禁用的按钮没有悬停提示，只能写成字。
 */
export function MapPickButton({
  provider,
  gridName,
  qthName,
}: {
  provider: MapProvider
  gridName: NamePath
  qthName: NamePath
}) {
  const form = Form.useFormInstance()
  const { map, station } = useStore()
  const wide = Grid.useBreakpoint().md ?? true
  const [open, setOpen] = useState(false)
  const disabled = provider === 'none'

  const button = (
    <Button icon={<EnvironmentOutlined />} disabled={disabled} onClick={() => setOpen(true)}>
      在地图上选
    </Button>
  )

  return (
    <div style={{ marginBottom: 24 }}>
      {disabled && wide ? <Tooltip title={NO_MAP}>{button}</Tooltip> : button}
      {disabled && !wide && (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
          {NO_MAP}
        </Typography.Text>
      )}
      {open && provider !== 'none' && (
        <Suspense fallback={null}>
          <MapPicker
            open
            provider={provider}
            amapKey={map.amapKey}
            fieldGrid={(form.getFieldValue(gridName) as string | undefined) ?? undefined}
            fieldQth={(form.getFieldValue(qthName) as string | undefined) ?? undefined}
            stationGrid={station.myGridsquare}
            onCancel={() => setOpen(false)}
            onPick={({ grid, qth }) => {
              form.setFieldValue(gridName, grid)
              if (qth !== undefined) form.setFieldValue(qthName, qth)
              setOpen(false)
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
