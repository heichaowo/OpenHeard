import type { ReactNode } from 'react'
import { Divider, Form, Input, InputNumber, Space, Tag, Typography } from 'antd'
import { isValidCallsign, normalizeCallsign } from '@core'
import type { Qso, QsoField } from '@core'
import type { MapProvider } from '../api'
import { CallInput } from './CallInput'
import { MapPickButton } from './MapPickButton'

/**
 * 人可以编辑的字段。待确认队列和日志里的编辑用同一份，两处填的是同一件事。
 *
 * 时间、频率、波段和模式不在这里。它们来自观测，改它们要连带重算波段，
 * 而手工补录的记录没有来源可丢，删了重录代价是零。
 */
export type QsoFormValues = Pick<
  Qso,
  | 'call'
  | 'rstSent'
  | 'rstRcvd'
  | 'gridsquare'
  | 'qth'
  | 'myGridsquare'
  | 'myQth'
  | 'myDevice'
  | 'myAntenna'
  | 'myPower'
  | 'myHeightM'
  | 'note'
>

export function QsoFields({
  autoFocus = true,
  recalledFrom,
  qsos,
  mapProvider,
  aiFilled,
}: {
  autoFocus?: boolean
  /** 对方 QTH 和网格是从哪次通联补来的，已经按当前时区格式化好。 */
  recalledFrom?: string
  /** 给了才带呼号联想，不给就是普通输入框——这样 recall.test.tsx 不用改。 */
  qsos?: Qso[]
  /** 给了才带「在地图上选」按钮，没给就没有。recall.test.tsx 不在 StoreProvider 里渲染这个组件。 */
  mapProvider?: MapProvider
  /** 草稿里哪几个字段是 AI 填的，标签上挂一个 AI。 */
  aiFilled?: QsoField[]
}) {
  const label = (key: QsoField, text: string): ReactNode =>
    aiFilled?.includes(key) ? (
      <>
        {text}
        <Tag color="purple" style={{ marginInlineStart: 6, marginInlineEnd: 0 }}>
          AI
        </Tag>
      </>
    ) : (
      text
    )
  return (
    <>
      <Form.Item
        name="call"
        label={label('call', '对方呼号')}
        normalize={normalizeCallsign}
        rules={[
          { required: true, message: '呼号必填' },
          {
            validator: (_, value: string) =>
              !value || isValidCallsign(value)
                ? Promise.resolve()
                : Promise.reject(new Error('呼号格式不对')),
          },
        ]}
      >
        {qsos ? (
          <CallInput qsos={qsos} autoFocus={autoFocus} placeholder="BD7KLO" />
        ) : (
          <Input autoFocus={autoFocus} placeholder="BD7KLO" />
        )}
      </Form.Item>
      <Space wrap>
        <Form.Item name="rstSent" label={label('rstSent', '发出报告')}>
          <Input style={{ width: 100 }} />
        </Form.Item>
        <Form.Item name="rstRcvd" label={label('rstRcvd', '收到报告')}>
          <Input style={{ width: 100 }} />
        </Form.Item>
      </Space>
      <Space wrap>
        <Form.Item name="gridsquare" label="对方网格">
          <Input style={{ width: 100 }} placeholder="OM24" />
        </Form.Item>
        <Form.Item name="qth" label={label('qth', '对方 QTH')}>
          <Input style={{ width: 140 }} />
        </Form.Item>
      </Space>
      {recalledFrom !== undefined && (
        <Typography.Paragraph type="secondary" style={{ marginTop: -12 }}>
          QTH 和网格来自 {recalledFrom} 那次通联，改掉就是。
        </Typography.Paragraph>
      )}
      {mapProvider !== undefined && (
        <MapPickButton provider={mapProvider} gridName="gridsquare" qthName="qth" />
      )}
      <Divider titlePlacement="left" plain>
        本台
      </Divider>
      <Space wrap>
        <Form.Item name="myGridsquare" label="网格">
          <Input style={{ width: 100 }} placeholder="OM24" />
        </Form.Item>
        <Form.Item name="myQth" label="QTH">
          <Input style={{ width: 200 }} />
        </Form.Item>
      </Space>
      <Form.Item name="myDevice" label="设备">
        <Input />
      </Form.Item>
      <Form.Item name="myAntenna" label="天线">
        <Input />
      </Form.Item>
      <Space wrap>
        <Form.Item name="myPower" label="功率">
          <Input style={{ width: 100 }} />
        </Form.Item>
        <Form.Item name="myHeightM" label="天线高度（米）">
          <InputNumber style={{ width: 140 }} />
        </Form.Item>
      </Space>
      <Form.Item name="note" label={label('note', '备注')}>
        <Input.TextArea rows={2} />
      </Form.Item>
    </>
  )
}
