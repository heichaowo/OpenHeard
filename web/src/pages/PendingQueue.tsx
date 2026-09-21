import { useState } from 'react'
import { App, Button, Descriptions, Drawer, Form, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { Card, Grid } from 'antd'
import { AsyncContent } from '../components/AsyncContent'
import { PageHeader } from '../components/PageHeader'
import { QsoFields } from '../components/QsoFields'
import { FIELD_LABELS as LABELS } from '../fields'
import type { QsoFormValues } from '../components/QsoFields'
import { missingFields, normalizeCallsign } from '@core'
import { ApiError, errorText } from '../api'
import { confirmDiscard } from '../discard'
import type { Activity, QsoDraft, QsoField } from '@core'
import { useRecall } from '../recall'
import { useStore } from '../store'
import type { PendingRow } from '../store'
import { useTime } from '../useTime'

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
  const time = useTime()
  const { recordings } = useStore()
  const columns: TableColumnsType<Activity> = [
    // 外层表头写了时区，这张展开表也要写，否则两个时间看着像不同口径。
    { title: `时间 ${time.label}`, dataIndex: 'startAt', render: time.at, width: 220 },
    {
      title: '时长',
      dataIndex: 'durationS',
      render: (s: number) => `${s.toFixed(1)} 秒`,
      width: 100,
    },
    {
      // 模拟 FM 空中不带身份信息，对方呼号只能靠回忆。能听回去才填得准。
      title: '录音',
      key: 'audio',
      width: 260,
      render: (_, row) =>
        recordings.has(row.id) ? (
          <audio
            controls
            preload="none"
            src={`/api/recordings/${encodeURIComponent(row.id)}`}
            style={{ height: 32, maxWidth: 240 }}
          />
        ) : (
          <Typography.Text type="secondary">没有</Typography.Text>
        ),
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
  const { message, modal } = App.useApp()
  const [form] = Form.useForm<QsoFormValues>()
  const { pending, promote, ignore, qsos, loading, error, refresh } = useStore()
  const wide = Grid.useBreakpoint().md ?? true
  const [editing, setEditing] = useState<PendingRow | null>(null)
  // 哪一行正在入库。楼下用手机弱网确认时，慢一点就会想再点一下。
  const [busyId, setBusyId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { recalledAt, onValuesChange, reset: resetRecall } = useRecall(form, qsos)
  const time = useTime()

  const open = (row: PendingRow) => {
    setEditing(row)
    resetRecall()
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
      message.error(errorText(e))
    }
  }

  const straightIn = async (row: PendingRow) => {
    setBusyId(row.cluster.id)
    try {
      await promote(row.cluster.id, row.draft)
      message.success(`${row.draft.call} 已入库`)
    } catch (e) {
      fail(e)
    } finally {
      setBusyId(null)
    }
  }

  const close = () => confirmDiscard(modal, form, '填', () => setEditing(null))

  const submit = async (values: QsoFormValues) => {
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
    setSubmitting(true)
    try {
      await promote(editing.cluster.id, draft)
      setEditing(null)
      message.success(`${draft.call} 已入库`)
    } catch (e) {
      fail(e)
    } finally {
      setSubmitting(false)
    }
  }

  const columns: TableColumnsType<PendingRow> = [
    {
      title: `时间 ${time.label}`,
      key: 'startAt',
      render: (_, row) => time.at(row.cluster.startAt),
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
            <Button
              type="link"
              loading={busyId === row.cluster.id}
              disabled={busyId !== null && busyId !== row.cluster.id}
              onClick={() => straightIn(row)}
            >
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
        onClose={close}
        extra={
          <Button type="primary" loading={submitting} onClick={() => form.submit()}>
            入库
          </Button>
        }
      >
        {editing && (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={`时间 ${time.label}`}>
                {time.at(editing.cluster.startAt)}
              </Descriptions.Item>
              <Descriptions.Item label="频率">{editing.draft.freqMhz} MHz</Descriptions.Item>
              <Descriptions.Item label="波段">{editing.draft.band}</Descriptions.Item>
              <Descriptions.Item label="模式">{editing.draft.mode}</Descriptions.Item>
              <Descriptions.Item label="来源">{originOf(editing)}</Descriptions.Item>
            </Descriptions>
            <Form
              form={form}
              layout="vertical"
              onFinish={submit}
              onValuesChange={onValuesChange}
              style={{ marginTop: 24 }}
            >
              <QsoFields recalledFrom={recalledAt === undefined ? undefined : time.at(recalledAt)} />
              {/* 让输入框里按回车也能提交，抽屉标题栏那个按钮在表单外面 */}
              <Button htmlType="submit" style={{ display: 'none' }} />
            </Form>
          </>
        )}
      </Drawer>
    </>
  )
}
