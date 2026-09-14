import { useState } from 'react'
import {
  App,
  Button,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { isValidCallsign, missingFields, normalizeCallsign } from '@core'
import type { Activity, Qso, QsoDraft, QsoField } from '@core'
import { useStore } from '../store'
import type { PendingRow } from '../store'
import { utcSec } from '../time'

/** 人可以编辑的字段。机器填的那些在抽屉上半部只读显示。 */
type FormValues = Pick<
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

const LABELS: Partial<Record<QsoField, string>> = {
  call: '对方呼号',
  startAt: '时间',
  freqMhz: '频率',
  band: '波段',
  mode: '模式',
  rstSent: '发出报告',
  rstRcvd: '收到报告',
}

const ORIGIN_LABELS: Record<Activity['origin'], string> = {
  'brandmeister': 'BrandMeister',
  'sdr-fm': '模拟接收机',
  'sdr-dmr': '数字接收机',
}

function ActivityTable({ activities }: { activities: Activity[] }) {
  const columns: TableColumnsType<Activity> = [
    { title: '时间', dataIndex: 'startAt', render: utcSec, width: 200 },
    {
      title: '时长',
      dataIndex: 'durationS',
      render: (s: number) => `${s.toFixed(1)} 秒`,
      width: 100,
    },
    {
      title: '发射方',
      dataIndex: 'mine',
      render: (mine: boolean, row) => (
        <Space>
          <Tag color={mine ? 'blue' : 'default'}>{mine ? '本台' : '对方'}</Tag>
          {row.callsign ??
            (mine ? null : (
              <Typography.Text type="secondary">呼号未知</Typography.Text>
            ))}
        </Space>
      ),
      width: 200,
    },
    {
      title: '音频信噪比',
      dataIndex: 'audioSnrDb',
      render: (v?: number) => (v === undefined ? '—' : `${v.toFixed(1)} dB`),
    },
    {
      title: '误码率',
      dataIndex: 'ber',
      render: (v?: number) => (v === undefined ? '—' : `${v}%`),
    },
  ]
  return (
    <Table
      size="small"
      rowKey="id"
      columns={columns}
      dataSource={activities}
      pagination={false}
    />
  )
}

export default function PendingQueue() {
  const { message } = App.useApp()
  const [form] = Form.useForm<FormValues>()
  const { pending, promote, ignore } = useStore()
  const [editing, setEditing] = useState<PendingRow | null>(null)

  const open = (row: PendingRow) => {
    setEditing(row)
    form.setFieldsValue({
      call: row.draft.call ?? '',
      rstSent: row.draft.rstSent,
      rstRcvd: row.draft.rstRcvd,
      gridsquare: undefined,
      qth: undefined,
      myQth: row.draft.myQth,
      myDevice: row.draft.myDevice,
      myAntenna: row.draft.myAntenna,
      myPower: row.draft.myPower,
      myHeightM: row.draft.myHeightM,
      note: undefined,
    })
  }

  const submit = (values: FormValues) => {
    if (!editing) return
    const draft: QsoDraft = {
      ...editing.draft,
      ...values,
      call: normalizeCallsign(values.call),
    }
    const still = missingFields(draft)
    if (still.length > 0) {
      message.error(`还缺 ${still.map((k) => LABELS[k] ?? k).join('、')}`)
      return
    }
    promote(editing.cluster.id, draft)
    setEditing(null)
    message.success(`${draft.call} 已入库`)
  }

  const columns: TableColumnsType<PendingRow> = [
    {
      title: '时间 UTC',
      key: 'startAt',
      render: (_, row) => utcSec(row.cluster.startAt),
      width: 200,
    },
    {
      title: '信道',
      key: 'channel',
      render: (_, row) =>
        row.cluster.activities[0]?.channel ??
        ORIGIN_LABELS[row.cluster.activities[0]!.origin],
    },
    {
      title: '模式',
      key: 'mode',
      render: (_, row) => <Tag>{row.draft.mode}</Tag>,
      width: 90,
    },
    {
      title: '发射',
      key: 'activities',
      render: (_, row) =>
        `${row.cluster.activities.length} 次 / ${row.cluster.endAt - row.cluster.startAt} 秒`,
      width: 140,
    },
    {
      title: '对方呼号',
      key: 'call',
      render: (_, row) => row.draft.call ?? <Tag color="orange">待补</Tag>,
      width: 120,
    },
    {
      title: '还缺',
      key: 'missing',
      render: (_, row) =>
        row.missing.length === 0 ? (
          <Tag color="green">可直接入库</Tag>
        ) : (
          <Space size={4}>
            {row.missing.map((k) => (
              <Tag key={k} color="orange">
                {LABELS[k] ?? k}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 160,
      render: (_, row) => (
        <Space>
          <Button type="link" onClick={() => open(row)}>
            确认
          </Button>
          <Popconfirm title="不记这次对话？" onConfirm={() => ignore(row.cluster.id)}>
            <Button type="link" danger>
              忽略
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <Typography.Paragraph type="secondary">
        机器能填的已经填好。模拟信号不带身份信息，所以对方呼号只能人补。
      </Typography.Paragraph>
      <Table
        rowKey={(row) => row.cluster.id}
        columns={columns}
        dataSource={pending}
        pagination={false}
        scroll={{ x: 900 }}
        locale={{ emptyText: '队列空了' }}
        expandable={{
          expandedRowRender: (row) => <ActivityTable activities={row.cluster.activities} />,
        }}
      />
      <Drawer
        title="确认入库"
        size={420}
        open={editing !== null}
        onClose={() => setEditing(null)}
        extra={
          <Button type="primary" onClick={() => form.submit()}>
            入库
          </Button>
        }
      >
        {editing && (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="时间 UTC">
                {utcSec(editing.cluster.startAt)}
              </Descriptions.Item>
              <Descriptions.Item label="频率">{editing.draft.freqMhz} MHz</Descriptions.Item>
              <Descriptions.Item label="波段">{editing.draft.band}</Descriptions.Item>
              <Descriptions.Item label="模式">{editing.draft.mode}</Descriptions.Item>
              <Descriptions.Item label="来源">
                {ORIGIN_LABELS[editing.cluster.activities[0]!.origin]}
              </Descriptions.Item>
            </Descriptions>
            <Form form={form} layout="vertical" onFinish={submit} style={{ marginTop: 24 }}>
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
            </Form>
          </>
        )}
      </Drawer>
    </>
  )
}
