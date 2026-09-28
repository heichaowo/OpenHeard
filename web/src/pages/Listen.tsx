import { useEffect, useState } from 'react'
import { App, Button, Card, Form, Grid } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { missingFields, normalizeCallsign } from '@core'
import type { QsoDraft, QsoField } from '@core'
import { AsyncContent } from '../components/AsyncContent'
import { PageHeader } from '../components/PageHeader'
import type { QsoFormValues } from '../components/QsoFields'
import { ApiError, errorText } from '../api'
import type { Conversation, ConversationPick, ConversationsParams } from '../api'
import { confirmDiscard } from '../discard'
import { FIELD_LABELS as LABELS } from '../fields'
import '../listen.css'
import { usePlayerViewKey } from '../player'
import { useRecall } from '../recall'
import { useStore } from '../store'
import { draftFor, fromPending } from '../subset'
import { useTime } from '../useTime'
import { Chips } from './listen/Chips'
import { ConfirmDrawer } from './listen/ConfirmDrawer'
import { DayNav } from './listen/DayNav'
import { dayRange, isDayTab, originOfSrc, statusOfTab } from './listen/model'
import type { Src, Tab } from './listen/model'
import { DesktopRows, PhoneRows } from './listen/Rows'
import type { RowVM } from './listen/Rows'
import { SearchBox } from './listen/SearchBox'
import { SweepBar } from './listen/SweepBar'
import { TopPanel } from './listen/TopPanel'
import { useConversationList } from './listen/useConversationList'
import { useUnloggedCount } from './listen/useUnloggedCount'

/** 每一档一句空态说明。搜索时另有一句，不查这张表。 */
const EMPTY_TEXT: Record<Tab, string> = {
  pending: '队列空了，没有等着确认的对话',
  unlogged: '未入库里没有等着处理的对话',
  all: '这天没有听到什么',
  logged: '这天没有入库的通联',
  ignored: '这天没有忽略的对话',
}

/**
 * 收听页。取代待确认队列和收听记录两页：发射聚成对话，对话结算成通联，
 * 待确认只是这张图里的一档。
 */
export default function Listen() {
  const { message, modal } = App.useApp()
  const [form] = Form.useForm<QsoFormValues>()
  const {
    pending,
    promote,
    ignore,
    ignoreMany,
    qsos,
    analogEnabled,
    loading: storeLoading,
    error: storeError,
    refresh,
  } = useStore()
  const wide = Grid.useBreakpoint().md ?? true
  const time = useTime()
  const [searchParams, setSearchParams] = useSearchParams()

  const tabParam = searchParams.get('tab') as Tab | null
  const day = searchParams.get('day') ?? 'today'
  const channel = searchParams.get('ch') ?? undefined
  const qParam = searchParams.get('q') ?? ''
  const srcParam = searchParams.get('src') as Src | null
  // 缺省模拟，模拟守听关着就缺省数字——跟直播条读的是同一个 store 效果值。
  const src: Src = srcParam ?? (analogEnabled ? 'fm' : 'digital')

  const setParam = (patch: Record<string, string | undefined>, opts?: { replace?: boolean }) => {
    const next = new URLSearchParams(searchParams)
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k)
      else next.set(k, v)
    }
    setSearchParams(next, opts)
  }

  // 默认档：等 store 首次加载完再选一次，往后刷新都不再改——不然手指落下去
  // 那一刻，待确认的最后一条刚结算完，列表整个换成了全部。
  useEffect(() => {
    if (tabParam !== null || storeLoading) return
    setParam({ tab: pending.length > 0 ? 'pending' : 'all' }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam, storeLoading, pending.length])

  const tab: Tab = tabParam ?? 'pending'

  // 输入立刻回显在框里，300ms 之后才真的触发请求。
  const [debouncedQ, setDebouncedQ] = useState(qParam)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(qParam), 300)
    return () => clearTimeout(t)
  }, [qParam])
  const searching = debouncedQ.trim().length >= 2

  const [from, to] = dayRange(day, time.zone)

  const unloggedParams: ConversationsParams | null =
    tab === 'unlogged' && !searching ? { view: 'unlogged' } : null
  const unloggedList = useConversationList(unloggedParams, 15000)

  const dayParams: ConversationsParams | null =
    isDayTab(tab) && !searching
      ? { from, to, origin: originOfSrc(src), status: statusOfTab(tab), channel }
      : null
  const dayList = useConversationList(dayParams, day === 'today' ? 15000 : null)

  const searchListParams: ConversationsParams | null = searching ? { q: debouncedQ.trim() } : null
  const searchList = useConversationList(searchListParams, 15000)

  const unloggedCount = useUnloggedCount()

  // 收听页换了筛选（档、天、来源、信道、搜索）也要停正在放的那段。
  usePlayerViewKey([tab, day, src, channel ?? '', debouncedQ.trim()].join('|'))

  // 未入库/按天看两条各自只在自己的档上跑，不会同时都有 viewParams，
  // 所以哪一档被选中就用哪一个当「按天看/未入库」那一路的当前列表。
  const tabList = tab === 'unlogged' ? unloggedList : isDayTab(tab) ? dayList : null

  const rows: Conversation[] = searching
    ? searchList.items
    : tab === 'pending'
      ? pending.map(fromPending)
      : (tabList?.items ?? [])

  const listLoading = searching ? searchList.loading : tab === 'pending' ? storeLoading : (tabList?.loading ?? false)
  const listError = searching ? searchList.error : tab === 'pending' ? storeError : tabList?.error
  const hasMore = searching ? searchList.hasMore : tab === 'pending' ? false : (tabList?.hasMore ?? false)
  const loadingMore = searching ? searchList.loadingMore : (tabList?.loadingMore ?? false)
  const loadMore = searching ? searchList.loadMore : (tabList?.loadMore ?? (() => undefined))
  const newCount = searching ? searchList.newCount : (tabList?.newCount ?? 0)
  const showNew = searching ? searchList.showNew : (tabList?.showNew ?? (() => undefined))
  const retry = searching ? searchList.retry : tab === 'pending' ? refresh : (tabList?.retry ?? (() => undefined))
  const emptyText = searching ? '没有匹配的呼号' : EMPTY_TEXT[tab]
  // 搜索跨天，pending/unlogged 两档没有分页——都没有「更早的/新的」这类分页 UI。
  const paged = searching || tab === 'unlogged' || isDayTab(tab)

  // 结算（入库/忽略）之后重拉当前视图，未入库和按天看/搜索各拉各的第一页，
  // 待确认走 store.pending 自己的轮询，store.refresh() 已经在 promote/ignore/
  // ignoreMany 内部跑过一次，这里不用再叫。
  const settleView = async (ids: string[]) => {
    if (searching) {
      await searchList.settleRefresh(ids)
    } else if (tab === 'unlogged') {
      await unloggedList.settleRefresh(ids)
    } else if (isDayTab(tab)) {
      await dayList.settleRefresh(ids)
    }
  }

  const showNewest = searching || (tab !== 'pending' && tab !== 'unlogged')
  const newest = showNewest ? rows[0] : undefined

  // 这一段里除了本台没有别人：喊了一声没人应，这种段永远变不成通联。
  const aloneIn = (conv: Conversation) => conv.activities.every((a) => a.mine)
  // 这一段现在算哪几次发射，没挑过就是全部。
  const chosen = (conv: Conversation) => subset[conv.id] ?? conv.activities.map((a) => a.id)
  const narrowed = (conv: Conversation) => chosen(conv).length !== conv.activities.length
  const draftOf = (conv: Conversation) => draftFor(conv.activities, conv.draft ?? {}, chosen(conv))
  const missingOf = (conv: Conversation) => missingFields(draftOf(conv))
  const ignoreTitle = (vm: RowVM) =>
    vm.narrowed ? `只忽略挑中的 ${vm.chosenIds.length} 次发射？` : '不记这次对话？'

  const [subset, setSubset] = useState<Record<string, string[]>>({})
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const pickedCount = Object.keys(picked).length
  const [busyId, setBusyId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [editing, setEditing] = useState<{ conv: Conversation; ids: string[]; draft: QsoDraft } | null>(null)
  const { recalledAt, onValuesChange, reset: resetRecall } = useRecall(form, qsos)

  // 换了档，上一档挑中的那几个不该带到这一档来。
  useEffect(() => {
    setPicked({})
  }, [tab])

  const rowVms: RowVM[] = rows.map((conv) => ({
    conv,
    chosenIds: chosen(conv),
    narrowed: narrowed(conv),
    draft: draftOf(conv),
    missing: missingOf(conv),
    aloneIn: aloneIn(conv),
  }))

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.missing?.length) {
      message.error(`还缺 ${e.missing.map((k) => LABELS[k as QsoField] ?? k).join('、')}`)
    } else {
      message.error(errorText(e))
    }
  }

  const open = (vm: RowVM) => {
    const { draft } = vm
    setEditing({ conv: vm.conv, ids: vm.chosenIds, draft })
    resetRecall()
    form.setFieldsValue({
      call: draft.call ?? '',
      rstSent: draft.rstSent,
      rstRcvd: draft.rstRcvd,
      gridsquare: undefined,
      qth: undefined,
      myGridsquare: draft.myGridsquare,
      myQth: draft.myQth,
      myDevice: draft.myDevice,
      myAntenna: draft.myAntenna,
      myPower: draft.myPower,
      myHeightM: draft.myHeightM,
      note: undefined,
    })
  }

  const straightIn = async (vm: RowVM) => {
    setBusyId(vm.conv.id)
    try {
      await promote(vm.chosenIds, vm.draft)
      await settleView([vm.conv.id])
      message.success(`${vm.draft.call} 已入库`)
    } catch (e) {
      fail(e)
    } finally {
      setBusyId(null)
    }
  }

  const ignoreRow = async (vm: RowVM) => {
    setBusyId(vm.conv.id)
    try {
      await ignore(vm.conv.id, vm.chosenIds)
      await settleView([vm.conv.id])
    } catch (e) {
      fail(e)
    } finally {
      setBusyId(null)
    }
  }

  const close = () => confirmDiscard(modal, form, '填', () => setEditing(null))

  const submit = async (values: QsoFormValues) => {
    if (!editing) return
    const draft: QsoDraft = { ...editing.draft, ...values, call: normalizeCallsign(values.call) }
    const still = missingFields(draft)
    if (still.length > 0) {
      message.error(`还缺 ${still.map((k) => LABELS[k] ?? k).join('、')}`)
      return
    }
    setSubmitting(true)
    // 和「直接入库」共用一把锁：抽屉里的那次还没回来，列表上别的按钮再点
    // 就是两个入库请求同时在路上。
    setBusyId(editing.conv.id)
    try {
      await promote(editing.ids, draft)
      await settleView([editing.conv.id])
      setEditing(null)
      message.success(`${draft.call} 已入库`)
    } catch (e) {
      fail(e)
    } finally {
      setSubmitting(false)
      setBusyId(null)
    }
  }

  const snapshot = (list: Conversation[]) => Object.fromEntries(list.map((c) => [c.id, chosen(c)]))

  const togglePicked = (vm: RowVM) =>
    setPicked((m) => {
      const { [vm.conv.id]: was, ...rest } = m
      return was === undefined ? { ...m, ...snapshot([vm.conv]) } : rest
    })

  const pickShort = () =>
    setPicked(snapshot(rows.filter((c) => c.activities.length === 1 && c.endAt - c.startAt < 3)))

  const pickAlone = () => setPicked(snapshot(rows.filter(aloneIn)))

  // 数字侧一大半是一两秒的空按，永远不会变成通联。一条一条点忽略太熬人。
  const sweep = async () => {
    if (pickedCount === 0) return
    setClearing(true)
    try {
      const picks: ConversationPick[] = Object.entries(picked).map(([id, activityIds]) => ({ id, activityIds }))
      const r = await ignoreMany(picks)
      await settleView(picks.map((p) => p.id))
      setPicked({})
      message.success(`忽略了 ${r.ignored} 段` + (r.missing.length > 0 ? `，${r.missing.length} 段已经变了` : ''))
    } catch (e) {
      fail(e)
    } finally {
      setClearing(false)
    }
  }

  const actions = {
    onToggleActivity: (conv: Conversation, id: string) =>
      setSubset((m) => {
        const now = m[conv.id] ?? conv.activities.map((a) => a.id)
        const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id]
        return { ...m, [conv.id]: next }
      }),
    onChooseActivities: (conv: Conversation, ids: string[]) => setSubset((m) => ({ ...m, [conv.id]: ids })),
    onOpen: open,
    onStraightIn: straightIn,
    onIgnore: ignoreRow,
    onTogglePicked: togglePicked,
    onSetPicked: (ids: string[]) =>
      setPicked((m) => Object.fromEntries(rows.filter((c) => ids.includes(c.id)).map((c) => [c.id, m[c.id] ?? chosen(c)]))),
    ignoreTitle,
  }

  const sweepable = (tab === 'pending' || tab === 'unlogged') && !searching

  // 默认档还没定下来之前只显示骨架，不闪一下另一档再跳过去。
  if (tabParam === null) {
    return (
      <>
        <PageHeader title="收听" note="听到的每一次发射都在这里，不只是有本台的那几段。" />
        <Card className="flush-card">
          <AsyncContent loading empty={false} onRetry={() => undefined}>
            {null}
          </AsyncContent>
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader title="收听" note="听到的每一次发射都在这里，不只是有本台的那几段。" />
      <Chips
        tab={tab}
        onSelect={(t) => setParam({ tab: t, q: undefined })}
        pendingCount={pending.length}
        unloggedCount={unloggedCount.count}
      />
      <SearchBox value={qParam} onChange={(v) => setParam({ q: v }, { replace: true })} searching={searching} loadedCount={rows.length} />
      <TopPanel newest={newest} showNewest={showNewest} />
      {isDayTab(tab) && !searching && (
        <DayNav
          day={day}
          onDay={(d) => setParam({ day: d })}
          src={src}
          onSrc={(s) => setParam({ src: s })}
          channel={channel}
          onChannel={(c) => setParam({ ch: c })}
          channels={dayList.channels ?? []}
        />
      )}
      <Card className="flush-card">
        <AsyncContent
          loading={listLoading}
          error={listError}
          empty={rows.length === 0}
          emptyText={emptyText}
          onRetry={retry}
        >
          {sweepable && (
            <SweepBar
              total={rows.length}
              aloneCount={rows.filter(aloneIn).length}
              pickedCount={pickedCount}
              clearing={clearing}
              onPickShort={pickShort}
              onPickAlone={pickAlone}
              onClear={() => setPicked({})}
              onSweep={sweep}
            />
          )}
          {paged && (
            <div className="listen-new-bar">
              <Button size="small" disabled={newCount === 0} onClick={showNew}>
                {newCount === 0 ? '没有更新的' : `有 ${newCount} 段新的`}
              </Button>
            </div>
          )}
          {wide ? (
            <DesktopRows rows={rowVms} busyId={busyId} actions={actions} picked={sweepable ? picked : undefined} />
          ) : (
            <PhoneRows rows={rowVms} busyId={busyId} actions={actions} picked={sweepable ? picked : undefined} />
          )}
          {hasMore && (
            <div className="state-box">
              <Button onClick={loadMore} loading={loadingMore}>
                更早的
              </Button>
            </div>
          )}
        </AsyncContent>
      </Card>
      <ConfirmDrawer
        editing={editing}
        wide={wide}
        form={form}
        recalledFrom={recalledAt === undefined ? undefined : time.at(recalledAt)}
        onValuesChange={onValuesChange}
        submitting={submitting}
        onClose={close}
        onSubmit={submit}
      />
    </>
  )
}
