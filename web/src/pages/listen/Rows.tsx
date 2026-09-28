import { Fragment, useState } from 'react'
import { Button, Card, Checkbox, Collapse, List, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { Link } from 'react-router-dom'
import type { HeardItem, Conversation } from '../../api'
import type { QsoDraft, QsoField } from '@core'
import { AudioPill } from '../../components/AudioPill'
import { PlayAll } from '../../components/PlayAll'
import { useStore } from '../../store'
import { useTime } from '../../useTime'
import { FIELD_LABELS as LABELS } from '../../fields'
import { ORIGIN_LABEL, STATUS_COLOR, STATUS_LABEL, isUnresolved, senderText } from './model'

/** 一段里一次显示多少次发射，热闹的话务组一段能有几百次。 */
const ACTIVITY_PAGE = 20

/** 收听页里一行/一张卡对应的对话，连同当前挑中的子集一起算好，Rows 只管画。 */
export interface RowVM {
  conv: Conversation
  chosenIds: string[]
  narrowed: boolean
  draft: QsoDraft
  missing: QsoField[]
  aloneIn: boolean
}

interface RowActions {
  onToggleActivity: (conv: Conversation, id: string) => void
  onChooseActivities: (conv: Conversation, ids: string[]) => void
  onOpen: (vm: RowVM) => void
  onStraightIn: (vm: RowVM) => void
  onIgnore: (vm: RowVM) => void
  /** 手机上单张卡片的选中框。 */
  onTogglePicked?: (vm: RowVM) => void
  /** 桌面表格的批量选中框：antd 给的是选中之后的整份 key 列表。 */
  onSetPicked?: (ids: string[]) => void
  ignoreTitle: (vm: RowVM) => string
}

const durationText = (s: number) => `${Math.round(s)} 秒`

/** 一次发射一行：谁发的、时长、信噪比/误码率、录音。手机和桌面共用。 */
function ActivityLine({ a, myCall }: { a: HeardItem; myCall?: string }) {
  const time = useTime()
  const digital = a.origin !== 'sdr-fm'
  return (
    <Space size={8} wrap>
      <Typography.Text className="mono">{time.atShort(a.startAt)}</Typography.Text>
      <Tag color={a.mine ? 'blue' : 'default'}>{a.mine ? '本台' : '对方'}</Tag>
      <Typography.Text className={a.callsign ? 'callsign' : undefined}>{senderText(a, myCall)}</Typography.Text>
      <Typography.Text type="secondary">{a.durationS.toFixed(1)} 秒</Typography.Text>
      <Typography.Text type="secondary">
        {digital
          ? a.ber === undefined
            ? '误码率 —'
            : `误码率 ${a.ber}%`
          : a.audioSnrDb === undefined
            ? '信噪比 —'
            : `信噪比 ${a.audioSnrDb.toFixed(1)} dB`}
      </Typography.Text>
      <AudioPill id={a.id} durationS={a.durationS} />
    </Space>
  )
}

/**
 * 手机上一段里的逐次发射，能取消勾选。聚类猜错时把不属于这次通联的
 * 那几次拿掉，它们不结算，下一轮自己会分出去。已结算的对话没有勾选框：
 * 它已经是通联或者已经忽略了，没有「挑哪几次」这回事。
 */
function ActivityListMobile({
  activities,
  chosen,
  checkable,
  onToggle,
  myCall,
}: {
  activities: HeardItem[]
  chosen: string[]
  checkable: boolean
  onToggle: (id: string) => void
  myCall?: string
}) {
  const [shown, setShown] = useState(ACTIVITY_PAGE)
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {activities.slice(0, shown).map((a) => (
        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {checkable && (
            <Checkbox checked={chosen.includes(a.id)} onChange={() => onToggle(a.id)} />
          )}
          <ActivityLine a={a} myCall={myCall} />
        </div>
      ))}
      {shown < activities.length && (
        <Button size="small" onClick={() => setShown((n) => n + ACTIVITY_PAGE)}>
          再显示 {Math.min(ACTIVITY_PAGE, activities.length - shown)} 次（共 {activities.length} 次）
        </Button>
      )}
    </Space>
  )
}

/** 桌面上一段里的逐次发射，展开表。取消勾选的道理和手机上一样。 */
function ActivityTableDesktop({
  activities,
  chosen,
  checkable,
  onChange,
  myCall,
}: {
  activities: HeardItem[]
  chosen: string[]
  checkable: boolean
  onChange: (ids: string[]) => void
  myCall?: string
}) {
  const time = useTime()
  const digital = activities.some((a) => a.origin !== 'sdr-fm')
  const columns: TableColumnsType<HeardItem> = [
    { title: `时间 ${time.label}`, dataIndex: 'startAt', render: time.at, width: 200 },
    {
      title: '发射方',
      key: 'sender',
      render: (_, a) => (
        <Space>
          <Tag color={a.mine ? 'blue' : 'default'}>{a.mine ? '本台' : '对方'}</Tag>
          <Typography.Text className={a.callsign ? 'callsign' : undefined}>
            {senderText(a, myCall)}
          </Typography.Text>
        </Space>
      ),
      width: 220,
    },
    { title: '时长', dataIndex: 'durationS', render: (s: number) => `${s.toFixed(1)} 秒`, width: 100 },
    {
      title: digital ? '误码率' : '信噪比',
      key: 'quality',
      width: 100,
      render: (_, a) =>
        digital
          ? a.ber === undefined
            ? '—'
            : `${a.ber}%`
          : a.audioSnrDb === undefined
            ? '—'
            : `${a.audioSnrDb.toFixed(1)} dB`,
    },
    {
      title: '录音',
      key: 'audio',
      width: 160,
      render: (_, a) => <AudioPill id={a.id} durationS={a.durationS} />,
    },
  ]
  return (
    <Table
      size="small"
      rowKey="id"
      columns={columns}
      dataSource={activities}
      rowSelection={
        checkable
          ? { selectedRowKeys: chosen, onChange: (keys) => onChange(keys as string[]) }
          : undefined
      }
      pagination={
        activities.length > ACTIVITY_PAGE
          ? { pageSize: ACTIVITY_PAGE, size: 'small', showSizeChanger: false }
          : false
      }
    />
  )
}

/** 状态和信道那一行的辅助信息（来源标签，没有信道名时用它兜底）。 */
const channelText = (conv: Conversation) => conv.activities[0]?.channel ?? ORIGIN_LABEL[conv.origin]

/** 呼号格子：已入库显示 call 和 RST，链到日志；没结算显示草稿呼号或者「待补/没人回」。 */
function CallCell({ vm }: { vm: RowVM }) {
  const { conv, draft, aloneIn } = vm
  if (conv.status === 'logged' && conv.qso) {
    return (
      <Link to={`/log?q=${encodeURIComponent(conv.qso.call)}`} className="callsign">
        {conv.qso.call} {conv.qso.rstSent}/{conv.qso.rstRcvd}
      </Link>
    )
  }
  if (draft.call) return <span className="callsign">{draft.call}</span>
  return aloneIn ? <Tag>没人回</Tag> : <Tag color="orange">呼号待补</Tag>
}

/** 一行的操作按钮。已经结算过的（已入库/已忽略）没有动作，位置留空不是压缩掉——
 *  位置不能随数据变，别的行的按钮不能因为这一行没按钮就挪位置。 */
function RowActionsCell({
  vm,
  busyId,
  actions,
  block,
}: {
  vm: RowVM
  busyId: string | null
  actions: RowActions
  block?: boolean
}) {
  const { conv, missing, chosenIds } = vm
  if (!isUnresolved(conv.status)) return block ? null : <Typography.Text type="secondary">—</Typography.Text>
  const ready = missing.length === 0
  const none = chosenIds.length === 0
  const busy = busyId === conv.id
  const buttons = (
    <>
      <Button
        type={block ? 'primary' : 'link'}
        block={block}
        loading={busy}
        disabled={!ready || none || (busyId !== null && !busy)}
        onClick={() => actions.onStraightIn(vm)}
      >
        直接入库
      </Button>
      <Button
        type={block ? 'default' : 'link'}
        block={block}
        disabled={none || (busyId !== null && !busy)}
        onClick={() => actions.onOpen(vm)}
      >
        {ready ? '编辑' : '确认'}
      </Button>
      <Popconfirm title={actions.ignoreTitle(vm)} disabled={none} onConfirm={() => actions.onIgnore(vm)}>
        <Button type={block ? 'default' : 'link'} block={block} danger disabled={none}>
          忽略
        </Button>
      </Popconfirm>
    </>
  )
  // 手机卡片上按钮占满一行，靠 .pending-card-actions > * { flex: 1 } 三等分——
  // 那条规则认的是直接子元素，Space 会在中间插一层 wrapper，把它接不上。
  return block ? <Fragment>{buttons}</Fragment> : <Space size={0} className="compact-links">{buttons}</Space>
}

/** 桌面表格。 */
export function DesktopRows({
  rows,
  busyId,
  actions,
  picked,
}: {
  rows: RowVM[]
  busyId: string | null
  actions: RowActions
  /** 有值才带批量选中的复选框列——待确认、未入库这两档才有。 */
  picked?: Record<string, string[]>
}) {
  const { station } = useStore()
  const time = useTime()

  const columns: TableColumnsType<RowVM> = [
    {
      title: '状态',
      key: 'status',
      width: 84,
      render: (_, r) => <Tag color={STATUS_COLOR[r.conv.status]}>{STATUS_LABEL[r.conv.status]}</Tag>,
    },
    { title: `时间 ${time.label}`, key: 'startAt', render: (_, r) => time.at(r.conv.startAt), width: 184 },
    { title: '信道', key: 'channel', ellipsis: true, render: (_, r) => channelText(r.conv) },
    { title: '呼号', key: 'call', ellipsis: true, width: 200, render: (_, r) => <CallCell vm={r} /> },
    {
      title: '发射',
      key: 'activities',
      width: 150,
      render: (_, r) =>
        r.narrowed
          ? `挑中 ${r.chosenIds.length} / ${r.conv.activities.length} 次`
          : `${r.conv.activities.length} 次 · ${durationText(r.conv.endAt - r.conv.startAt)}`,
    },
    { title: '播放', key: 'play', width: 140, render: (_, r) => <PlayAll activities={r.conv.activities} /> },
    {
      title: '操作',
      key: 'action',
      width: 212,
      fixed: 'right' as const,
      render: (_, r) => <RowActionsCell vm={r} busyId={busyId} actions={actions} />,
    },
  ]

  return (
    <Table
      rowKey={(r) => r.conv.id}
      columns={columns}
      dataSource={rows}
      pagination={false}
      scroll={{ x: 1250 }}
      rowSelection={
        picked
          ? {
              selectedRowKeys: Object.keys(picked),
              onChange: (keys) => actions.onSetPicked?.(keys as string[]),
            }
          : undefined
      }
      expandable={{
        expandedRowRender: (r) => (
          <ActivityTableDesktop
            activities={r.conv.activities}
            chosen={r.chosenIds}
            checkable={isUnresolved(r.conv.status)}
            onChange={(ids) => actions.onChooseActivities(r.conv, ids)}
            myCall={station.myCallsign}
          />
        ),
      }}
    />
  )
}

/** 手机上一段一张卡。 */
export function PhoneRows({
  rows,
  busyId,
  actions,
  picked,
}: {
  rows: RowVM[]
  busyId: string | null
  actions: RowActions
  picked?: Record<string, string[]>
}) {
  const { station } = useStore()
  const time = useTime()

  return (
    <List
      dataSource={rows}
      split={false}
      renderItem={(r) => {
        const { conv } = r
        return (
          <List.Item style={{ padding: '0 0 12px' }}>
            <Card size="small" style={{ width: '100%' }}>
              <div className="pending-card-top">
                <Space size={8}>
                  {picked && (
                    <Checkbox
                      checked={picked[conv.id] !== undefined}
                      onChange={() => actions.onTogglePicked?.(r)}
                    />
                  )}
                  <Tag color={STATUS_COLOR[conv.status]}>{STATUS_LABEL[conv.status]}</Tag>
                  <Typography.Text type="secondary">{time.atShort(conv.startAt)}</Typography.Text>
                </Space>
                <Typography.Text type="secondary" style={{ overflowWrap: 'anywhere' }}>
                  {channelText(conv)}
                </Typography.Text>
              </div>

              <div className="pending-card-call">
                <CallCell vm={r} />
              </div>

              <Space size={4} wrap style={{ marginBottom: 12 }}>
                {isUnresolved(conv.status) &&
                  (r.missing.length === 0 ? (
                    <Tag color="green">可直接入库</Tag>
                  ) : (
                    r.missing.map((k) => (
                      <Tag key={k} color="orange">
                        还缺{LABELS[k] ?? k}
                      </Tag>
                    ))
                  ))}
                <Typography.Text type="secondary">
                  {r.narrowed
                    ? `挑中 ${r.chosenIds.length} / ${conv.activities.length} 次`
                    : `${conv.activities.length} 次 · ${durationText(conv.endAt - conv.startAt)}`}
                </Typography.Text>
              </Space>

              <div style={{ marginBottom: 12 }}>
                <PlayAll activities={conv.activities} />
              </div>

              {isUnresolved(conv.status) && (
                <div className="pending-card-actions">
                  <RowActionsCell vm={r} busyId={busyId} actions={actions} block />
                </div>
              )}

              <Collapse
                ghost
                size="small"
                items={[
                  {
                    key: 'acts',
                    label: !r.narrowed
                      ? `逐次发射（${conv.activities.length}）`
                      : r.chosenIds.length === 0
                        ? '逐次发射（一次都没挑，挑几次才能确认或忽略）'
                        : `逐次发射（挑中 ${r.chosenIds.length} / ${conv.activities.length}）`,
                    children: (
                      <ActivityListMobile
                        activities={conv.activities}
                        chosen={r.chosenIds}
                        checkable={isUnresolved(conv.status)}
                        onToggle={(id) => actions.onToggleActivity(conv, id)}
                        myCall={station.myCallsign}
                      />
                    ),
                  },
                ]}
              />
            </Card>
          </List.Item>
        )
      }}
    />
  )
}
