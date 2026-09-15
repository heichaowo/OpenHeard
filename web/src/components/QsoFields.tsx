import { Divider, Form, Input, InputNumber, Space } from 'antd'
import { isValidCallsign, normalizeCallsign } from '@core'
import type { Qso } from '@core'

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
  | 'myQth'
  | 'myDevice'
  | 'myAntenna'
  | 'myPower'
  | 'myHeightM'
  | 'note'
>

export function QsoFields({ autoFocus = true }: { autoFocus?: boolean }) {
  return (
    <>
      <Form.Item
        name="call"
        label="对方呼号"
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
        <Input autoFocus={autoFocus} placeholder="BD7KLO" />
      </Form.Item>
      <Space>
        <Form.Item name="rstSent" label="发出报告">
          <Input style={{ width: 100 }} />
        </Form.Item>
        <Form.Item name="rstRcvd" label="收到报告">
          <Input style={{ width: 100 }} />
        </Form.Item>
      </Space>
      <Space>
        <Form.Item name="gridsquare" label="对方网格">
          <Input style={{ width: 100 }} placeholder="OM24" />
        </Form.Item>
        <Form.Item name="qth" label="对方 QTH">
          <Input style={{ width: 140 }} />
        </Form.Item>
      </Space>
      <Divider titlePlacement="left" plain>
        本台
      </Divider>
      <Form.Item name="myQth" label="QTH">
        <Input />
      </Form.Item>
      <Form.Item name="myDevice" label="设备">
        <Input />
      </Form.Item>
      <Form.Item name="myAntenna" label="天线">
        <Input />
      </Form.Item>
      <Space>
        <Form.Item name="myPower" label="功率">
          <Input style={{ width: 100 }} />
        </Form.Item>
        <Form.Item name="myHeightM" label="天线高度（米）">
          <InputNumber style={{ width: 140 }} />
        </Form.Item>
      </Space>
      <Form.Item name="note" label="备注">
        <Input.TextArea rows={2} />
      </Form.Item>
    </>
  )
}
