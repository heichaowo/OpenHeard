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
import { Card, Grid } from 'antd'
import { AsyncContent } from '../components/AsyncContent'
import { PageHeader } from '../components/PageHeader'
import { isValidCallsign, missingFields, normalizeCallsign } from '@core'
import { ApiError } from '../api'
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

/** 聚类应当保证 activities 非空，但类型不保证，所以渲染不能假设。 */
const originOf = (row: PendingRow) => {
  const first = row.cluster.activities[0]
  return first ? ORIGIN_LABELS[first.origin] : '—'
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
  const { pending, promote, ignore, loading, error, refresh } = useStore()
  const wide = Grid.useBreakpoint().md ?? true
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

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.missing?.length) {
      message.error(`还缺 ${e.missing.map((k) => LABELS[k as QsoField] ?? k).join('、')}`)
    } else {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  const straightIn = async (row: PendingRow) => {
    try {
      await promote(row.cluster.id, row.draft)
      message.success(`${row.draft.call} 已入库`)
    } catch (e) {
      fail(e)
    }
  }

  const submit = async (values: FormValues) => {
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
    try {
      await promote(editing.cluster.id, draft)
      setEditing(null)
      message.success(`${draft.call} 已入库`)
    } catch (e) {
      fail(e)
    }
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
      render: (_, row) => row.cluster.activities[0]?.channel ?? originOf(row),
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
        `${row.cluster.activities.length} 次 / ${Math.round(row.cluster.endAt - row.cluster.startAt)} 秒`,
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
      width: 220,
      fixed: wide ? ('right' as const) : undefined,
      render: (_, row) => (
        <Space size={0}>
          {row.missing.length === 0 && (
            <Button type="link" onClick={() => straightIn(row)}>
              直接入库
            </Button>
          )}
          <Button type="link" onClick={() => open(row)}>
            {row.missing.length === 0 ? '编辑' : '确认'}
          </Button>
          <Popconfirm
            title="不记这次对话？"
            onConfirm={() => ignore(row.cluster.id).catch(fail)}
          >
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
      <PageHeader
        title="待确认队列"
        note="机器能填的已经填好。模拟信号不带身份信息，所以对方呼号只能人补。"
      />
      <Card className="flush-card">
        <AsyncContent
          loading={loading}
          error={error}
          empty={pending.length === 0}
          emptyText="队列空了，没有等着确认的对话"
          onRetry={refresh}
        >
          <Table
            rowKey={(row) => row.cluster.id}
            columns={columns}
            dataSource={pending}
            pagination={false}
            scroll={{ x: 900 }}
            expandable={{
              expandedRowRender: (row) => <ActivityTable activities={row.cluster.activities} />,
            }}
          />
        </AsyncContent>
      </Card>
      <Drawer
        title="确认入库"
        size={420}
        open={editing !== null}
        maskClosable={false}
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
              <Descriptions.Item label="来源">{originOf(editing)}</Descriptions.Item>
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
              {/* 让输入框里按回车也能提交，抽屉标题栏那个按钮在表单外面 */}
              <Button htmlType="submit" style={{ display: 'none' }} />
            </Form>
          </>
        )}
      </Drawer>
    </>
  )
}
