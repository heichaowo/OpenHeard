import {
  App,
  Button,
  Card,
  DatePicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Typography,
} from 'antd'
import type { Dayjs } from 'dayjs'
import { bandOf, isValidCallsign, normalizeCallsign } from '@core'
import type { Mode, Qso } from '@core'
import { useStore } from '../store'
import { nowUtc, unixFromDisplayedUtc } from '../time'

type FormValues = Pick<
  Qso,
  | 'call'
  | 'freqMhz'
  | 'mode'
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
> & { at: Dayjs }

export default function QuickEntry() {
  const { message } = App.useApp()
  const { station, channels, addQso } = useStore()
  const [form] = Form.useForm<FormValues>()

  const initial: Partial<FormValues> = {
    at: nowUtc(),
    mode: 'FM',
    rstSent: '59',
    rstRcvd: '59',
    myQth: station.myQth,
    myDevice: station.myDevice,
    myAntenna: station.myAntenna,
    myPower: station.myPower,
    myHeightM: station.myHeightM,
  }

  const pickChannel = (name: string) => {
    const ch = channels.find((c) => c.name === name)
    if (ch) form.setFieldsValue({ freqMhz: ch.freqMhz, mode: ch.mode })
  }

  const submit = async ({ at, ...values }: FormValues) => {
    const band = bandOf(values.freqMhz)
    if (!band) {
      message.error('这个频率不在本台能用的波段里')
      return
    }
    const call = normalizeCallsign(values.call)
    try {
      await addQso({ ...values, call, startAt: unixFromDisplayedUtc(at), band })
      message.success(`${call} 已入库`)
      form.resetFields(['call', 'gridsquare', 'qth', 'note'])
      form.setFieldsValue({ at: nowUtc() })
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Card style={{ maxWidth: 560 }}>
      <Typography.Paragraph type="secondary">
        给没有任何观测的通联用。经过采集的通联走待确认队列，不在这里录。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={initial} onFinish={submit}>
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
          <Input autoFocus placeholder="BD7KLO" />
        </Form.Item>

        <Form.Item name="at" label="时间 UTC" rules={[{ required: true, message: '时间必填' }]}>
          <DatePicker showTime format="YYYY-MM-DD HH:mm:ss" style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item label="信道">
          <Select
            allowClear
            placeholder="从频谱表里挑，会带出频率和模式"
            onChange={pickChannel}
            options={channels.map((c) => ({ value: c.name, label: c.name }))}
          />
        </Form.Item>

        <Space>
          <Form.Item
            name="freqMhz"
            label="频率 MHz"
            rules={[{ required: true, message: '频率必填' }]}
          >
            <InputNumber style={{ width: 160 }} step={0.005} placeholder="439.525" />
          </Form.Item>
          <Form.Item name="mode" label="模式" rules={[{ required: true }]}>
            <Select<Mode>
              style={{ width: 120 }}
              options={[
                { value: 'FM', label: 'FM' },
                { value: 'DMR', label: 'DMR' },
              ]}
            />
          </Form.Item>
        </Space>

        <Space>
          <Form.Item name="rstSent" label="发出报告" rules={[{ required: true }]}>
            <Input style={{ width: 100 }} />
          </Form.Item>
          <Form.Item name="rstRcvd" label="收到报告" rules={[{ required: true }]}>
            <Input style={{ width: 100 }} />
          </Form.Item>
        </Space>

        <Space>
          <Form.Item name="gridsquare" label="对方网格">
            <Input style={{ width: 100 }} placeholder="OM24" />
          </Form.Item>
          <Form.Item name="qth" label="对方 QTH">
            <Input style={{ width: 180 }} />
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

        <Button type="primary" htmlType="submit">
          入库
        </Button>
      </Form>
    </Card>
  )
}
