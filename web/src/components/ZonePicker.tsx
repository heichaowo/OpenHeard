import { useMemo, useState } from 'react'
import { GlobalOutlined } from '@ant-design/icons'
import { Button, Popover, Select, Typography } from 'antd'
import { zoneMatches, zoneName } from '@core'
import { UTC, allZones, localZone, zoneLabel, zoneOption } from '../time'
import { usePreferences } from '../theme'

/**
 * 界面按哪个时区显示。
 *
 * 记录一律是 Unix 秒 UTC，导出的 ADIF 也一律 UTC，这里只改显示。
 * 列表是 IANA 的全部时区，另外把 UTC 和本机时区提到最前面当快捷项。
 */
export function ZonePicker() {
  const { zone, setZone } = usePreferences()
  const [open, setOpen] = useState(false)
  const here = localZone()

  const options = useMemo(() => {
    const quick = here === UTC ? [UTC] : [UTC, here]
    return [
      { label: '常用', options: quick.map((z) => ({ value: z, label: zoneOption(z) })) },
      {
        label: '全部',
        options: allZones()
          .filter((z) => !quick.includes(z))
          .map((z) => ({ value: z, label: zoneOption(z) })),
      },
    ]
  }, [here])

  const content = (
    <div style={{ width: 300 }}>
      <Select
        showSearch
        autoFocus
        style={{ width: '100%' }}
        value={zone}
        options={options}
        // 浏览器报的还是旧名（加尔各答是 Asia/Calcutta），按现名也要搜得到。
        filterOption={(input, option) =>
          zoneMatches(String((option as { value?: string } | undefined)?.value ?? ''), input)
        }
        onChange={(z: string) => {
          setZone(z)
          setOpen(false)
        }}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
        只改显示。记录和导出的 ADIF 一律是 UTC。
      </Typography.Paragraph>
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      title="显示时区"
      content={content}
    >
      <Button type="text" icon={<GlobalOutlined />} aria-label={`显示时区 ${zoneLabel(zone)}`}>
        {zone === UTC ? 'UTC' : zoneName(zone).split('/').pop()}
      </Button>
    </Popover>
  )
}
