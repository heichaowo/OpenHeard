import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Card, Checkbox, Collapse, List, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { Link } from 'react-router-dom'
import type { HeardItem, Conversation, ConversationPick } from '../../api'
import { channelLabel } from '@core'
import type { QsoDraft, QsoField } from '@core'
import { AudioPill } from '../../components/AudioPill'
import { PlayAll } from '../../components/PlayAll'
import { TimeHeader } from '../../components/TimeHeader'
import { useStore } from '../../store'
import { useTime } from '../../useTime'
import { FIELD_LABELS as LABELS } from '../../fields'
import {
  AI_TAG_COLOR,
  aiLine,
  aiTagCounts,
  aiTagOf,
  aiTagTitle,
  fmMembers,
  reasonLine,
  recognized,
  transcriptOf,
  transcriptText,
} from './ai'
import { STATUS_COLOR, STATUS_LABEL, isUnresolved, senderText } from './model'
import { SnapConfirm } from './SnapConfirm'

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
  /** 草稿里哪几个字段是 AI 填的，按挑中的那几次重算过。 */
  aiFilled: QsoField[]
  /** 已经不在最新结果里、先留在原处的行：按钮禁用，标「已变」。 */
  stale: boolean
}

interface RowActions {
  onToggleActivity: (conv: Conversation, id: string) => void
  onChooseActivities: (conv: Conversation, ids: string[]) => void
  onOpen: (vm: RowVM) => void
  onStraightIn: (vm: RowVM) => void
  /** snapshot 是确认框打开那一刻抄下来的那几次，不是此刻的。 */
  onIgnore: (snapshot: ConversationPick) => void | Promise<void>
  onDelete: (snapshot: ConversationPick[]) => void | Promise<void>
  /** 无意义档的「不是无意义」：这一段所有发射改判回来。 */
  onKeep: (vm: RowVM) => void
  /** 确认框开了没有，页面据此决定此刻能不能动列表。 */
  onConfirmOpen: (id: string, open: boolean) => void
  /** 手机上单张卡片的选中框。 */
  onTogglePicked?: (vm: RowVM) => void
  /** 桌面表格的批量选中框：antd 给的是选中之后的整份 key 列表。 */
  onSetPicked?: (ids: string[]) => void
}

/** 无意义档的行：只有播放、不是无意义、删除，没有勾选框，原因代替呼号。 */
export type RowsMode = 'normal' | 'meaningless'

/**
 * 展开哪几行由页面管：对话 id 变了（更早的发射补进来）页面要把展开的状态搬到新 id 上，
 * 页面决定此刻能不能动列表时也要看有没有展开的行。
 */
export interface Expansion {
  expanded: string[]
  onExpandedChange: (id: string, open: boolean) => void
}

const LOGGED_DELETE_REASON = '先在日志里删掉这条通联'
const DELETE_NOTE = '连同录音删掉，删了找不回来。'

const durationText = (s: number) => `${Math.round(s)} 秒`

/** 识别标记。无人声的转写是 whisper 凭空编的，只放在悬停里；失败的放错误原因。 */
function AiTagView({ a, aiEnabled }: { a: HeardItem; aiEnabled: boolean }) {
  const tag = aiTagOf(a, aiEnabled)
  if (tag === undefined) return null
  return (
    <Tag color={AI_TAG_COLOR[tag]} title={aiTagTitle(a, tag)} style={{ marginInlineEnd: 4 }}>
      {tag}
    </Tag>
  )
}

/**
 * 一次发射的转写，展开后每次发射占一行，装不下的截成省略号。
 * 模拟侧的发射一律占这一行，识别结果什么时候来都不改变高度。数字侧没有。
 */
function TranscriptLine({ a, aiEnabled }: { a: HeardItem; aiEnabled: boolean }) {
  if (a.origin !== 'sdr-fm') return null
  const text = transcriptOf(a)
  const hasTag = aiTagOf(a, aiEnabled) !== undefined
  return (
    <div className="transcript-line">
      <AiTagView a={a} aiEnabled={aiEnabled} />
      {text !== undefined ? (
        <span className="transcript-text" title={text}>
          {text}
        </span>
      ) : (
        !hasTag && (
          <Typography.Text type="secondary" className="transcript-text">
            {recognized(a) ? '没有识别出文字' : '还没识别'}
          </Typography.Text>
        )
      )}
    </div>
  )
}

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
  aiEnabled,
}: {
  activities: HeardItem[]
  chosen: string[]
  checkable: boolean
  onToggle: (id: string) => void
  myCall?: string
  aiEnabled: boolean
}) {
  const [shown, setShown] = useState(ACTIVITY_PAGE)
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {activities.slice(0, shown).map((a) => (
        <div key={a.id}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {checkable && <Checkbox checked={chosen.includes(a.id)} onChange={() => onToggle(a.id)} />}
            <ActivityLine a={a} myCall={myCall} />
          </div>
          <TranscriptLine a={a} aiEnabled={aiEnabled} />
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
  aiEnabled,
}: {
  activities: HeardItem[]
  chosen: string[]
  checkable: boolean
  onChange: (ids: string[]) => void
  myCall?: string
  aiEnabled: boolean
}) {
  const time = useTime()
  const digital = activities.some((a) => a.origin !== 'sdr-fm')
  const columns: TableColumnsType<HeardItem> = [
    { title: <TimeHeader />, dataIndex: 'startAt', render: time.at, width: 200 },
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
  // 只有模拟侧有识别。这一列占剩下的宽度，一次发射一行，装不下的截断。
  if (activities.some((a) => a.origin === 'sdr-fm')) {
    columns.push({
      title: '识别',
      key: 'transcript',
      ellipsis: true,
      className: 'transcript-cell',
      render: (_, a) => <TranscriptLine a={a} aiEnabled={aiEnabled} />,
    })
  }
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
const channelText = (conv: Conversation) => channelLabel(conv.channel)

/**
 * 呼号格子：已入库显示 call 和 RST，链到日志；没结算显示草稿呼号或者「待补/没人回」。
 * 草稿呼号是 AI 填的就挂一个 AI 标签；AI 填的其他字段写在悬停里（手机卡片另起一行写）。
 */
function CallCell({ vm }: { vm: RowVM }) {
  const { conv, draft, aloneIn, aiFilled } = vm
  if (conv.status === 'logged' && conv.qso) {
    return (
      <Link to={`/log?q=${encodeURIComponent(conv.qso.call)}`} className="callsign">
        {conv.qso.call} {conv.qso.rstSent}/{conv.qso.rstRcvd}
      </Link>
    )
  }
  if (draft.call) {
    return (
      <span title={aiLine(draft, aiFilled)}>
        <span className="callsign">{draft.call}</span>
        {aiFilled.includes('call') && (
          <Tag color="purple" style={{ marginInlineStart: 6, marginInlineEnd: 0 }}>
            AI
          </Tag>
        )}
      </span>
    )
  }
  return aloneIn ? <Tag>没人回</Tag> : <Tag color="orange">呼号待补</Tag>
}

/** 无意义档里呼号的位置写原因：没有人声、测试、噪声，或者人工判定。 */
function ReasonCell({ vm }: { vm: RowVM }) {
  return <Typography.Text type="secondary">{reasonLine(vm.conv)}</Typography.Text>
}

/** 删除按钮。没入库的和已忽略的能删；已入库的禁用，要先去日志里删掉那条通联。 */
function DeleteButton({
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
  const { conv, chosenIds } = vm
  const logged = conv.status === 'logged'
  const blocked = vm.stale || chosenIds.length === 0 || (busyId !== null && busyId !== conv.id)
  const button = (
    <Button type={block ? 'default' : 'link'} block={block} danger disabled={logged || blocked}>
      删除
    </Button>
  )
  if (logged) {
    // 禁用的按钮收不到悬停，套一层 span 才有提示；手机上没有悬停，原因写在卡片上。
    return block ? (
      button
    ) : (
      <Tooltip title={LOGGED_DELETE_REASON}>
        <span>{button}</span>
      </Tooltip>
    )
  }
  return (
    <SnapConfirm
      id={`delete:${conv.id}`}
      picks={() => [{ id: conv.id, activityIds: chosenIds }]}
      title={(snap) => `删掉这 ${snap.reduce((n, p) => n + p.activityIds.length, 0)} 次发射？`}
      description={DELETE_NOTE}
      disabled={blocked}
      onConfirm={actions.onDelete}
      onOpenChange={actions.onConfirmOpen}
    >
      {button}
    </SnapConfirm>
  )
}

/**
 * 一行的操作按钮。位置不能随数据变：该禁用就禁用，不拿掉。
 * 没结算的有直接入库、编辑、忽略、删除；已忽略的只有删除；已入库的删除禁用，
 * 要先去日志里删掉那条通联。无意义档只有不是无意义和删除。
 */
function RowActionsCell({
  vm,
  busyId,
  actions,
  block,
  mode,
}: {
  vm: RowVM
  busyId: string | null
  actions: RowActions
  block?: boolean
  mode: RowsMode
}) {
  const { conv, missing, chosenIds, stale } = vm
  const ready = missing.length === 0
  const none = chosenIds.length === 0
  const busy = busyId === conv.id
  const locked = busyId !== null && !busy
  const del = <DeleteButton vm={vm} busyId={busyId} actions={actions} block={block} />

  let buttons: ReactNode
  if (mode === 'meaningless') {
    buttons = (
      <>
        <Button
          type={block ? 'primary' : 'link'}
          block={block}
          loading={busy}
          disabled={stale || locked}
          onClick={() => actions.onKeep(vm)}
        >
          不是无意义
        </Button>
        {del}
      </>
    )
  } else if (isUnresolved(conv.status)) {
    buttons = (
      <>
        <Button
          type={block ? 'primary' : 'link'}
          block={block}
          loading={busy}
          disabled={stale || !ready || none || locked}
          onClick={() => actions.onStraightIn(vm)}
        >
          直接入库
        </Button>
        <Button
          type={block ? 'default' : 'link'}
          block={block}
          disabled={stale || none || locked}
          onClick={() => actions.onOpen(vm)}
        >
          {ready ? '编辑' : '确认'}
        </Button>
        <SnapConfirm
          id={`ignore:${conv.id}`}
          picks={() => [{ id: conv.id, activityIds: chosenIds }]}
          title={([p]) =>
            p!.activityIds.length !== conv.activities.length
              ? `只忽略挑中的 ${p!.activityIds.length} 次发射？`
              : '不记这次对话？'
          }
          disabled={stale || none}
          onConfirm={([p]) => actions.onIgnore(p!)}
          onOpenChange={actions.onConfirmOpen}
        >
          <Button type={block ? 'default' : 'link'} block={block} danger disabled={stale || none}>
            忽略
          </Button>
        </SnapConfirm>
        {del}
      </>
    )
  } else {
    // 已忽略的只有删除；已入库的删除禁用着，原因在悬停（桌面）或卡片上（手机）。
    buttons = del
  }
  // 手机卡片上按钮占满一行，靠 .pending-card-actions > * { flex: 1 } 等分——
  // 那条规则认的是直接子元素，Space 会在中间插一层 wrapper，把它接不上。
  return block ? <Fragment>{buttons}</Fragment> : <Space size={0} className="compact-links">{buttons}</Space>
}

/** 桌面表格。 */
export function DesktopRows({
  rows,
  busyId,
  actions,
  picked,
  mode = 'normal',
  expansion,
}: {
  rows: RowVM[]
  busyId: string | null
  actions: RowActions
  /** 有值才带批量选中的复选框列——待确认、未入库这两档才有。 */
  picked?: Record<string, string[]>
  mode?: RowsMode
  expansion: Expansion
}) {
  const { station, aiEnabled } = useStore()
  const time = useTime()

  const columns: TableColumnsType<RowVM> = [
    {
      title: '状态',
      key: 'status',
      width: 132,
      render: (_, r) => (
        <Space size={4}>
          <Tag color={STATUS_COLOR[r.conv.status]} style={{ marginInlineEnd: 0 }}>
            {STATUS_LABEL[r.conv.status]}
          </Tag>
          {r.stale && (
            <Tag color="warning" style={{ marginInlineEnd: 0 }}>
              已变
            </Tag>
          )}
        </Space>
      ),
    },
    { title: <TimeHeader />, key: 'startAt', render: (_, r) => time.at(r.conv.startAt), width: 184 },
    { title: '信道', key: 'channel', ellipsis: true, render: (_, r) => channelText(r.conv) },
    mode === 'meaningless'
      ? { title: '原因', key: 'reason', ellipsis: true, width: 200, render: (_, r) => <ReasonCell vm={r} /> }
      : { title: '呼号', key: 'call', ellipsis: true, width: 200, render: (_, r) => <CallCell vm={r} /> },
    {
      title: '发射',
      key: 'activities',
      width: 150,
      render: (_, r) =>
        r.narrowed
          ? `挑中 ${r.chosenIds.length} / ${r.conv.activities.length} 次`
          : `${r.conv.activities.length} 次 · ${durationText(r.conv.endAt - r.conv.startAt)}`,
    },
    // 胶囊最窄 118，加两边各 16 的内边距。再窄就被单元格的省略号截掉一截。
    { title: '播放', key: 'play', width: 156, render: (_, r) => <PlayAll activities={r.conv.activities} /> },
    {
      title: '操作',
      key: 'action',
      // 四个文字按钮：直接入库 68、编辑 40、忽略 40、删除 40，加两边各 16 的内边距。
      width: 244,
      fixed: 'right' as const,
      render: (_, r) => <RowActionsCell vm={r} busyId={busyId} actions={actions} mode={mode} />,
    },
  ]

  return (
    <Table
      rowKey={(r) => r.conv.id}
      columns={columns}
      dataSource={rows}
      pagination={false}
      scroll={{ x: 1300 }}
      rowSelection={
        picked
          ? {
              selectedRowKeys: Object.keys(picked),
              onChange: (keys) => actions.onSetPicked?.(keys as string[]),
            }
          : undefined
      }
      expandable={{
        expandedRowKeys: expansion.expanded,
        onExpand: (open, r) => expansion.onExpandedChange(r.conv.id, open),
        expandedRowRender: (r) => (
          <ActivityTableDesktop
            activities={r.conv.activities}
            chosen={r.chosenIds}
            checkable={isUnresolved(r.conv.status) && mode === 'normal'}
            onChange={(ids) => actions.onChooseActivities(r.conv, ids)}
            myCall={station.myCallsign}
            aiEnabled={aiEnabled}
          />
        ),
      }}
    />
  )
}

/**
 * 手机卡片上转写那一块：模拟侧的卡片固定留两行（高度写死，超出的截断），
 * 识别结果什么时候来都不推动下面的卡片。数字侧没有这一块。
 */
function CardTranscript({ conv }: { conv: Conversation }) {
  if (fmMembers(conv).length === 0) return null
  const text = transcriptText(conv)
  const waiting = fmMembers(conv).some((a) => !recognized(a))
  return (
    <div className="card-transcript" title={text}>
      {text ?? <Typography.Text type="secondary">{waiting ? '还没识别' : '没有识别出文字'}</Typography.Text>}
    </div>
  )
}

/** 手机上一段一张卡。 */
export function PhoneRows({
  rows,
  busyId,
  actions,
  picked,
  mode = 'normal',
  expansion,
}: {
  rows: RowVM[]
  busyId: string | null
  actions: RowActions
  picked?: Record<string, string[]>
  mode?: RowsMode
  expansion: Expansion
}) {
  const { station, aiEnabled } = useStore()
  const time = useTime()

  return (
    <List
      dataSource={rows}
      split={false}
      renderItem={(r) => {
        const { conv } = r
        const extra = mode === 'normal' ? aiLine(r.draft, r.aiFilled) : undefined
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
                  {r.stale && <Tag color="warning">已变</Tag>}
                  <Typography.Text type="secondary">{time.atShort(conv.startAt)}</Typography.Text>
                </Space>
                <Typography.Text type="secondary" style={{ overflowWrap: 'anywhere' }}>
                  {channelText(conv)}
                </Typography.Text>
              </div>

              {mode === 'meaningless' ? (
                <div style={{ marginBottom: 8 }}>
                  <ReasonCell vm={r} />
                </div>
              ) : (
                <div className="pending-card-call">
                  <CallCell vm={r} />
                </div>
              )}

              <Space size={4} wrap style={{ marginBottom: 8 }}>
                {mode === 'normal' &&
                  isUnresolved(conv.status) &&
                  (r.missing.length === 0 ? (
                    <Tag color="green">可直接入库</Tag>
                  ) : (
                    r.missing.map((k) => (
                      <Tag key={k} color="orange">
                        还缺{LABELS[k] ?? k}
                      </Tag>
                    ))
                  ))}
                {aiTagCounts(conv, aiEnabled).map(({ tag, n, title }) => (
                  <Tag key={tag} color={AI_TAG_COLOR[tag]} title={title} style={{ marginInlineEnd: 0 }}>
                    {n > 1 ? `${tag} ×${n}` : tag}
                  </Tag>
                ))}
                <Typography.Text type="secondary">
                  {r.narrowed
                    ? `挑中 ${r.chosenIds.length} / ${conv.activities.length} 次`
                    : `${conv.activities.length} 次 · ${durationText(conv.endAt - conv.startAt)}`}
                </Typography.Text>
              </Space>

              <CardTranscript conv={conv} />

              {extra !== undefined && (
                <div style={{ marginBottom: 8 }}>
                  <Typography.Text type="secondary">{extra}</Typography.Text>
                </div>
              )}

              <div style={{ marginBottom: 12 }}>
                <PlayAll activities={conv.activities} />
              </div>

              <div className="pending-card-actions">
                <RowActionsCell vm={r} busyId={busyId} actions={actions} block mode={mode} />
              </div>
              {conv.status === 'logged' && (
                <Typography.Text type="secondary" className="pending-card-reason">
                  {LOGGED_DELETE_REASON}
                </Typography.Text>
              )}

              <Collapse
                ghost
                size="small"
                activeKey={expansion.expanded.includes(conv.id) ? ['acts'] : []}
                onChange={(keys) => expansion.onExpandedChange(conv.id, keys.length > 0)}
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
                        checkable={isUnresolved(conv.status) && mode === 'normal'}
                        onToggle={(id) => actions.onToggleActivity(conv, id)}
                        myCall={station.myCallsign}
                        aiEnabled={aiEnabled}
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
