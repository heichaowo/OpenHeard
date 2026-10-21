import { useCallback, useEffect, useRef, useState } from 'react'
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
import { draftForWithAi } from '../subset'
import { useTime } from '../useTime'
import { useQuiet } from '../useQuiet'
import { Chips } from './listen/Chips'
import { ConfirmDrawer } from './listen/ConfirmDrawer'
import { DayNav } from './listen/DayNav'
import { dayRange, isDayTab, originOfSrc, statusOfTab } from './listen/model'
import type { Src, Tab } from './listen/model'
import { PageDeleteBar } from './listen/PageDeleteBar'
import { DesktopRows, PhoneRows } from './listen/Rows'
import type { RowVM } from './listen/Rows'
import { SearchBox } from './listen/SearchBox'
import { SweepBar } from './listen/SweepBar'
import { TopPanel } from './listen/TopPanel'
import { useConversationList } from './listen/useConversationList'
import { useMeaninglessCount } from './listen/useMeaninglessCount'
import { usePendingLive } from './listen/usePendingLive'
import { useUnloggedCount } from './listen/useUnloggedCount'

/** 每一档一句空态说明。搜索时另有一句，不查这张表。 */
const EMPTY_TEXT: Record<Tab, string> = {
  pending: '队列空了，没有等着确认的对话',
  unlogged: '未入库里没有等着处理的对话',
  all: '这天没有听到什么',
  logged: '这天没有入库的通联',
  ignored: '这天没有忽略的对话',
  meaningless: '没有无意义的对话',
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
    deleteConversations,
    setVerdict,
    station,
    qsos,
    analogEnabled,
    map,
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

  const [subset, setSubset] = useState<Record<string, string[]>>({})
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const pickedCount = Object.keys(picked).length
  // 展开的行由页面管：id 变了要搬，列表能不能动也要看有没有展开的。
  const [expanded, setExpanded] = useState<string[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [editing, setEditing] = useState<{
    conv: Conversation
    ids: string[]
    draft: QsoDraft
    aiFilled: QsoField[]
  } | null>(null)
  const { recalledAt, onValuesChange, reset: resetRecall } = useRecall(form, qsos)
  // 每次结算之后徽标的数不等下一个 15 秒。
  const [countKey, setCountKey] = useState(0)

  // 此刻能不能动列表：新对话直接插进来、没了的行直接摘掉，都只在人没有在操作的时候做。
  // 光看「有没有展开、有没有开抽屉」不够：直接点行上的按钮时这些都是原样，
  // 所以还要看确认框开着没有、最近几秒碰过屏幕没有。
  const quiet = useQuiet()
  const confirms = useRef(new Set<string>())
  const gate = useRef({ expanded: 0, picked: 0, editing: false })
  const canInsert = useCallback(
    () =>
      quiet() &&
      window.scrollY < 120 &&
      gate.current.expanded === 0 &&
      gate.current.picked === 0 &&
      !gate.current.editing &&
      confirms.current.size === 0,
    [quiet],
  )
  const onConfirmOpen = useCallback((id: string, open: boolean) => {
    if (open) confirms.current.add(id)
    else confirms.current.delete(id)
  }, [])

  const unloggedParams: ConversationsParams | null =
    tab === 'unlogged' && !searching ? { view: 'unlogged' } : null
  const unloggedList = useConversationList(unloggedParams, 15000, canInsert)

  const dayParams: ConversationsParams | null =
    isDayTab(tab) && !searching
      ? { from, to, origin: originOfSrc(src), status: statusOfTab(tab), channel }
      : null
  const dayList = useConversationList(dayParams, day === 'today' ? 15000 : null, canInsert)

  const meaninglessParams: ConversationsParams | null =
    tab === 'meaningless' && !searching ? { view: 'meaningless' } : null
  const meaninglessList = useConversationList(meaninglessParams, 15000, canInsert)

  const searchListParams: ConversationsParams | null = searching ? { q: debouncedQ.trim() } : null
  const searchList = useConversationList(searchListParams, 15000, canInsert)

  // 待确认走 store.pending，自己结算掉的对话 id 记在 pendingLive 里，
  // 那一份刷新回来时认得出它们是自己摘的，不当成「已变」。
  const pendingLive = usePendingLive(pending, canInsert)

  const unloggedCount = useUnloggedCount(countKey)
  const meaninglessCount = useMeaninglessCount(countKey)

  // 收听页换了筛选（档、天、来源、信道、搜索）也要停正在放的那段。
  usePlayerViewKey([tab, day, src, channel ?? '', debouncedQ.trim()].join('|'))

  // 各档只在自己的档上跑，不会同时都有 viewParams，
  // 所以哪一档被选中就用哪一个当「按天看/未入库/无意义」那一路的当前列表。
  const tabList =
    tab === 'unlogged' ? unloggedList : isDayTab(tab) ? dayList : tab === 'meaningless' ? meaninglessList : null

  // 待确认走 store.pending，不经过上面那几条路。包成同一个形状，下面不用分两套。
  const pendingView = {
    items: pendingLive.items,
    loading: storeLoading,
    error: storeError,
    hasMore: false,
    loadingMore: false,
    loadMore: () => undefined,
    newCount: pendingLive.buffer.length,
    newKind: 'backfill' as const,
    showNew: pendingLive.showNew,
    retry: () => void refresh(),
    stale: pendingLive.stale,
    renamed: pendingLive.renamed,
  }
  const view = searching ? searchList : tab === 'pending' ? pendingView : (tabList ?? searchList)
  const rows: Conversation[] = view.items

  const emptyText = searching ? '没有匹配的呼号' : EMPTY_TEXT[tab]

  // 结算（入库/忽略/删除）之后重拉当前视图，各档各拉各的第一页，
  // 待确认走 store.pending 自己的轮询，store.refresh() 已经在 promote/ignore/
  // ignoreMany 内部跑过一次，摘行由 pendingLive 在那一份拉取回来时做。
  const settleView = async (ids: string[]) => {
    if (searching) {
      await searchList.settleRefresh(ids)
    } else if (tabList !== null) {
      await tabList.settleRefresh(ids)
    }
    setCountKey((k) => k + 1)
  }

  // 做一件结算类的事，成功后把这几段从当前视图里摘掉。失败的话它们还在原处。
  const settle = async <R,>(ids: string[], act: () => Promise<R>): Promise<R> => {
    pendingLive.hold(ids)
    try {
      const r = await act()
      // 结算掉的对话，挑过的子集和勾选作废。余下拆出来的一段可能沿用同一个 id，
      // 也可能改名搬走这份挑选，带着已经入库的几次，所以要在合并新结果之前清。
      // 报了 missing 的没结算，原样留着。
      const missing = typeof r === 'object' && r !== null && 'missing' in r ? (r.missing as string[]) : []
      const done = ids.filter((id) => !missing.includes(id))
      const keep = <T,>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([k]) => !done.includes(k)))
      setSubset(keep)
      setPicked(keep)
      await settleView(ids)
      return r
    } catch (e) {
      // 没结算成，它们还在队列里。成功的不在这里清：拉取结果还没提交上来。
      pendingLive.release(ids)
      throw e
    }
  }

  const showNewest = searching || isDayTab(tab)
  const newest = showNewest ? rows[0] : undefined

  // 这一段里除了本台没有别人：喊了一声没人应，这种段永远变不成通联。
  const aloneIn = (conv: Conversation) => conv.activities.every((a) => a.mine)
  // 这一段现在算哪几次发射，没挑过就是全部。
  const chosen = (conv: Conversation) => subset[conv.id] ?? conv.activities.map((a) => a.id)

  // 对话 id 变了（更早的发射补进来，或者一段拆开、合并）：挑中的、勾选的、展开的搬到新 id 上，
  // 和新成员取交集，只会少不会多——没看过的新成员不跟着被结算。
  // 渲染时直接调整，不等 effect：新 id 那一帧不能露出「全选」的样子。
  const [seenRenamed, setSeenRenamed] = useState(view.renamed)
  if (view.renamed !== seenRenamed) {
    setSeenRenamed(view.renamed)
    const target = (id: string) => {
      const to = view.renamed[id]
      return to === undefined ? undefined : rows.find((c) => c.id === to)
    }
    const move = (m: Record<string, string[]>) => {
      const out = { ...m }
      for (const old of Object.keys(m)) {
        const next = target(old)
        if (next === undefined) continue
        delete out[old]
        out[next.id] = m[old]!.filter((id) => next.activities.some((a) => a.id === id))
      }
      return out
    }
    if (Object.keys(subset).some((k) => target(k) !== undefined)) setSubset(move(subset))
    if (Object.keys(picked).some((k) => target(k) !== undefined)) setPicked(move(picked))
    if (expanded.some((k) => target(k) !== undefined)) setExpanded(expanded.map((k) => target(k)?.id ?? k))
  }

  const rowVms: RowVM[] = rows.map((conv) => {
    const ids = chosen(conv)
    const sub = draftForWithAi(conv.activities, conv.draft ?? {}, ids, conv.aiFilled, station.myCallsign)
    return {
      conv,
      chosenIds: ids,
      narrowed: ids.length !== conv.activities.length,
      draft: sub.draft,
      missing: missingFields(sub.draft),
      aloneIn: aloneIn(conv),
      aiFilled: sub.aiFilled,
      stale: view.stale.has(conv.id),
    }
  })

  useEffect(() => {
    gate.current = {
      expanded: expanded.filter((id) => rows.some((c) => c.id === id)).length,
      picked: Object.keys(picked).filter((id) => rows.some((c) => c.id === id)).length,
      editing: editing !== null,
    }
  })

  // 换了档，上一档挑中的、展开的不该带到这一档来。
  useEffect(() => {
    setPicked({})
    setExpanded([])
  }, [tab])

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.missing?.length) {
      message.error(`还缺 ${e.missing.map((k) => LABELS[k as QsoField] ?? k).join('、')}`)
    } else {
      message.error(errorText(e))
    }
  }

  const open = (vm: RowVM) => {
    const { draft } = vm
    setEditing({ conv: vm.conv, ids: vm.chosenIds, draft, aiFilled: vm.aiFilled })
    resetRecall()
    form.setFieldsValue({
      call: draft.call ?? '',
      rstSent: draft.rstSent,
      rstRcvd: draft.rstRcvd,
      // 网格留空，呼号联想才补得上；QTH 和备注可能是 AI 填的，不能清掉，
      // 不然抽屉里入库的和直接入库的不是同一份。
      gridsquare: undefined,
      qth: draft.qth,
      myGridsquare: draft.myGridsquare,
      myQth: draft.myQth,
      myDevice: draft.myDevice,
      myAntenna: draft.myAntenna,
      myPower: draft.myPower,
      myHeightM: draft.myHeightM,
      note: draft.note,
    })
  }

  const straightIn = async (vm: RowVM) => {
    setBusyId(vm.conv.id)
    try {
      await settle([vm.conv.id], () => promote(vm.chosenIds, vm.draft))
      message.success(`${vm.draft.call} 已入库`)
    } catch (e) {
      fail(e)
    } finally {
      setBusyId(null)
    }
  }

  const ignoreRow = async (pick: ConversationPick) => {
    setBusyId(pick.id)
    try {
      await settle([pick.id], () => ignore(pick.id, pick.activityIds))
    } catch (e) {
      fail(e)
    } finally {
      setBusyId(null)
    }
  }

  // 删除只删确认框打开那一刻抄下的那几次，确认框开着时进来的回复没人看过。
  const deleteRows = async (snapshot: ConversationPick[]) => {
    const ids = snapshot.map((p) => p.id)
    if (snapshot.length === 1) setBusyId(ids[0]!)
    else {
      setBusyId('*')
      setClearing(true)
    }
    try {
      const r = await settle(ids, () => deleteConversations(snapshot))
      const gone = ids.filter((id) => !r.missing.includes(id))
      setExpanded((e) => e.filter((k) => !gone.includes(k)))
      message.success(`删掉了 ${r.deleted} 段` + (r.missing.length > 0 ? `，${r.missing.length} 段已经变了` : ''))
    } catch (e) {
      fail(e)
    } finally {
      setBusyId(null)
      setClearing(false)
    }
  }

  // 不是无意义：这一段每次发射都改判成「保留」，它回到原来的档里。
  const keepRow = async (vm: RowVM) => {
    setBusyId(vm.conv.id)
    try {
      await settle([vm.conv.id], () =>
        setVerdict(
          vm.conv.activities.map((a) => a.id),
          false,
        ),
      )
      message.success('改判了，这段回到原来的档里')
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
      await settle([editing.conv.id], () => promote(editing.ids, draft))
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
      const r = await settle(
        picks.map((p) => p.id),
        () => ignoreMany(picks),
      )
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
    onDelete: deleteRows,
    onKeep: keepRow,
    onConfirmOpen,
    onTogglePicked: togglePicked,
    onSetPicked: (ids: string[]) =>
      setPicked((m) => Object.fromEntries(rows.filter((c) => ids.includes(c.id)).map((c) => [c.id, m[c.id] ?? chosen(c)]))),
  }

  const expansion = {
    expanded,
    onExpandedChange: (id: string, open: boolean) =>
      setExpanded((e) => (open ? (e.includes(id) ? e : [...e, id]) : e.filter((k) => k !== id))),
  }

  const sweepable = (tab === 'pending' || tab === 'unlogged') && !searching
  const mode = tab === 'meaningless' && !searching ? 'meaningless' : 'normal'

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

  const rowProps = { rows: rowVms, busyId, actions, picked: sweepable ? picked : undefined, mode, expansion } as const

  return (
    <>
      <PageHeader title="收听" note="听到的每一次发射都在这里，不只是有本台的那几段。" />
      <Chips
        tab={tab}
        onSelect={(t) => setParam({ tab: t, q: undefined })}
        pendingCount={pending.length}
        unloggedCount={unloggedCount.count}
        meaninglessCount={meaninglessCount}
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
          loading={view.loading}
          error={view.error}
          empty={rows.length === 0}
          emptyText={emptyText}
          onRetry={view.retry}
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
              picks={() => Object.entries(picked).map(([id, activityIds]) => ({ id, activityIds }))}
              onDelete={deleteRows}
              onConfirmOpen={onConfirmOpen}
            />
          )}
          {mode === 'meaningless' && (
            <PageDeleteBar
              count={rowVms.filter((r) => !r.stale).length}
              deleting={clearing}
              picks={() =>
                rowVms
                  .filter((r) => !r.stale)
                  .map((r) => ({ id: r.conv.id, activityIds: r.conv.activities.map((a) => a.id) }))
              }
              onDelete={deleteRows}
              onConfirmOpen={onConfirmOpen}
            />
          )}
          <div className="listen-new-bar">
            <Button size="small" disabled={view.newCount === 0} onClick={view.showNew}>
              {view.newCount === 0
                ? '没有更新的'
                : view.newKind === 'backfill'
                  ? `有 ${view.newCount} 段新补进来的`
                  : `有 ${view.newCount} 段新的`}
            </Button>
          </div>
          {wide ? <DesktopRows {...rowProps} /> : <PhoneRows {...rowProps} />}
          {view.hasMore && (
            <div className="state-box">
              <Button onClick={view.loadMore} loading={view.loadingMore}>
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
        qsos={qsos}
        onValuesChange={onValuesChange}
        submitting={submitting}
        onClose={close}
        onSubmit={submit}
        mapProvider={map.provider}
      />
    </>
  )
}
