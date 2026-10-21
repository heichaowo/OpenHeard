import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Grid, Input, List, Modal, Space, Spin, Typography } from 'antd'
import { gridCenter, isValidGrid, toGrid } from '@core'
import type { AdapterFactory, LatLon, MapAdapter, SearchHit } from './map/adapter'

/** 地图加载超过这么久还没画出来，就当打不开：国内连 OpenStreetMap 常常只是一直转圈。 */
export const LOAD_TIMEOUT_MS = 10_000

/** 没有任何线索时的起点：整个中国。 */
const CHINA: LatLon = { lat: 35, lon: 104 }

const ZOOM_BY_LENGTH: Record<number, number> = { 4: 8, 6: 11, 8: 14 }

/** 两种地图各自的适配器，用到哪个才下载哪个：leaflet 和高德的加载代码都不进主包。 */
const defaultFactory: AdapterFactory = async (provider, init) =>
  provider === 'amap' ? (await import('./map/amap')).createAmap(init) : (await import('./map/osm')).createOsm(init)

export interface MapPickResult {
  /** 6 位网格；选点没动过时是输入框里原来的那个。 */
  grid: string
  /** 勾了「同时填 QTH」并且查到了才有。 */
  qth?: string
}

export interface MapPickerProps {
  open: boolean
  provider: 'amap' | 'osm'
  amapKey?: string
  /** 输入框里现在的网格。合法的话从它开始，标记摆在它的中心。 */
  fieldGrid?: string
  /** 输入框里现在的 QTH。网格没填时，用它查出地图的起点。 */
  fieldQth?: string
  /** 本台网格。网格和 QTH 都没有线索时当起点，但不摆标记。 */
  stationGrid?: string
  onCancel: () => void
  onPick: (r: MapPickResult) => void
  /** 测试用：换掉真地图。 */
  factory?: AdapterFactory
}

/**
 * 选网格的弹窗。点地图、拖标记或者搜地名，下面显示这个点的 6 位网格（要填的）和 8 位网格（参考）。
 *
 * 标记只在人点过、拖过、搜到过，或者输入框里本来就有合法网格时才有；
 * 「用这个网格」在那之前是禁用的，不然打开就按会把本台网格填成对方的。
 * 点没动过时填回输入框里原来的网格，不是重新算一遍的中心点。
 */
export default function MapPicker({
  open,
  provider,
  amapKey,
  fieldGrid,
  fieldQth,
  stationGrid,
  onCancel,
  onPick,
  factory = defaultFactory,
}: MapPickerProps) {
  const wide = Grid.useBreakpoint().md ?? true
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const adapterRef = useRef<MapAdapter | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  // 加载失败的原话。高德换了 key 要刷新页面，只有这句说得清。
  const [failReason, setFailReason] = useState<string | undefined>()

  const fieldValid = fieldGrid !== undefined && isValidGrid(fieldGrid)
  const [point, setPoint] = useState<LatLon | null>(() => (fieldValid ? gridCenter(fieldGrid) : null))
  // 人动过没有：没动过就把输入框原来的网格还回去。
  const [moved, setMoved] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()
  const [withQth, setWithQth] = useState(false)
  const reverseSeq = useRef(0)

  // 起点：输入框的网格中心，否则本台网格中心，否则整个中国。QTH 只在没有网格时才查。
  const start = (): { center: LatLon; zoom: number } => {
    if (fieldValid) return { center: gridCenter(fieldGrid), zoom: ZOOM_BY_LENGTH[fieldGrid.length] ?? 11 }
    if (stationGrid !== undefined && isValidGrid(stationGrid)) return { center: gridCenter(stationGrid), zoom: 9 }
    return { center: CHINA, zoom: 4 }
  }

  const place = (p: LatLon) => {
    setPoint(p)
    setMoved(true)
    setNotice(undefined)
  }
  const placeRef = useRef(place)
  useEffect(() => {
    placeRef.current = place
  })

  // 搭地图。失败（脚本加载不了、10 秒没画出来）就退到手填，弹窗和输入框照常能用。
  useEffect(() => {
    if (el === null) return
    let dead = false
    let failed = false
    const s = start()
    const made = factory(provider, { el, center: s.center, zoom: s.zoom, amapKey })
    const timer = setTimeout(() => {
      failed = true
      setStatus('failed')
    }, LOAD_TIMEOUT_MS)
    made.then(
      (a) => {
        clearTimeout(timer)
        // 超时、弹窗关了才画完的，丢掉。
        if (dead || failed) {
          a.destroy()
          return
        }
        adapterRef.current = a
        a.onPick((p) => placeRef.current(p))
        setStatus('ready')
        // 没有网格线索时，用输入框里的 QTH 查一次起点，只移视图，不摆标记。
        if (!fieldValid && fieldQth !== undefined && fieldQth.trim() !== '') {
          a.search(fieldQth.trim()).then(
            (h) => {
              if (!dead && h[0] !== undefined) a.setView(h[0].point, 10)
            },
            () => undefined,
          )
        }
      },
      (e: unknown) => {
        clearTimeout(timer)
        if (dead) return
        setFailReason(e instanceof Error ? e.message : undefined)
        setStatus('failed')
      },
    )
    return () => {
      dead = true
      clearTimeout(timer)
      adapterRef.current?.destroy()
      adapterRef.current = null
    }
    // 起点只在地图容器出现那一刻定。输入框里的值之后改了不该把地图拽走。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [el, provider, amapKey])

  // 标记和格子跟着选中的点走。
  useEffect(() => {
    const a = adapterRef.current
    if (a === null || status !== 'ready') return
    a.setMarker(point)
    a.setCell(point === null ? null : toGrid(point.lat, point.lon, 6))
  }, [point, status])

  // 反查地名只在勾了「同时填 QTH」时做：Nominatim 每秒最多一个请求，高德有配额。
  // 结果连同它是哪个点的一起存，换了点之后旧结果自然对不上，不用在 effect 里同步清。
  const pointKey = point === null ? '' : `${point.lat},${point.lon}`
  const [found, setFound] = useState<{ key: string; qth?: string } | undefined>()
  useEffect(() => {
    const mine = ++reverseSeq.current
    const a = adapterRef.current
    if (!withQth || point === null || a === null || status !== 'ready') return
    const key = `${point.lat},${point.lon}`
    a.reverse(point).then(
      (q) => {
        if (mine === reverseSeq.current) setFound({ key, qth: q })
      },
      () => {
        if (mine === reverseSeq.current) setFound({ key })
      },
    )
  }, [withQth, point, status])
  const qth = withQth && found?.key === pointKey ? found.qth : undefined
  // 失败了就没有反查，复选框也藏起来了，不能让按钮永远等下去。
  const qthPending = withQth && point !== null && status !== 'failed' && found?.key !== pointKey

  const search = async () => {
    const a = adapterRef.current
    const q = query.trim()
    if (a === null || q === '') return
    setSearching(true)
    setNotice(undefined)
    try {
      const found = await a.search(q)
      setHits(found)
      if (found[0] === undefined) {
        setNotice('没有找到这个地名')
        return
      }
      place(found[0].point)
      a.setView(found[0].point, 13)
    } catch {
      setHits([])
      setNotice('搜不到，地名服务没有回应')
    } finally {
      setSearching(false)
    }
  }

  const grid6 = point === null ? undefined : toGrid(point.lat, point.lon, 6)
  const grid8 = point === null ? undefined : toGrid(point.lat, point.lon, 8)
  // 没动过就是输入框原来的那个（可能是 4 位或 8 位），动过才是这个点算出来的 6 位。
  const filled = !moved && fieldValid ? fieldGrid.toUpperCase() : grid6

  const confirm = () => {
    if (filled === undefined) return
    onPick({ grid: filled, qth: withQth ? qth : undefined })
  }

  return (
    <Modal
      title="在地图上选网格"
      open={open}
      onCancel={onCancel}
      destroyOnHidden
      width={wide ? 720 : 'calc(100vw - 16px)'}
      footer={
        <Space>
          <Button onClick={onCancel}>取消</Button>
          {/* 反查没回来就按，勾了的 QTH 会悄悄丢掉。等它回来，失败了也会放开。 */}
          <Button type="primary" disabled={point === null || qthPending} loading={qthPending} onClick={confirm}>
            用这个网格
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {status === 'failed' ? (
          <Alert
            type="warning"
            showIcon
            message="地图打不开，网格可以直接填"
            description={
              provider === 'osm' ? 'OpenStreetMap 在国内可能连不上。可以在设置里换成高德。' : failReason
            }
          />
        ) : (
          <>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                placeholder="搜地名，按回车"
                value={query}
                disabled={status !== 'ready'}
                onChange={(e) => setQuery(e.target.value)}
                onPressEnter={() => void search()}
              />
              <Button loading={searching} disabled={status !== 'ready'} onClick={() => void search()}>
                搜索
              </Button>
            </Space.Compact>
            {notice !== undefined && <Typography.Text type="secondary">{notice}</Typography.Text>}
            {hits.length > 1 && (
              <List
                size="small"
                bordered
                dataSource={hits}
                renderItem={(h) => (
                  <List.Item
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      place(h.point)
                      adapterRef.current?.setView(h.point, 13)
                    }}
                  >
                    <Typography.Text ellipsis style={{ maxWidth: '100%' }}>
                      {h.name}
                      {h.detail !== undefined && <Typography.Text type="secondary"> {h.detail}</Typography.Text>}
                    </Typography.Text>
                  </List.Item>
                )}
              />
            )}
            <Spin spinning={status === 'loading'}>
              <div ref={setEl} data-testid="map-canvas" style={{ height: wide ? 380 : '50vh', background: 'var(--surface-soft)' }} />
            </Spin>
          </>
        )}
        <div>
          {grid6 === undefined ? (
            status !== 'failed' && (
              <Typography.Text type="secondary">点地图、拖标记或者搜个地名，选出一个点。</Typography.Text>
            )
          ) : (
            <Space size={16} wrap>
              <span>
                {filled!.length} 位 <Typography.Text strong className="mono">{filled}</Typography.Text>（要填的）
              </span>
              {filled !== grid8 && (
                <Typography.Text type="secondary">
                  8 位 <span className="mono">{grid8}</span>（参考）
                </Typography.Text>
              )}
            </Space>
          )}
        </div>
        {status !== 'failed' && (
          <Checkbox checked={withQth} onChange={(e) => setWithQth(e.target.checked)}>
            同时填 QTH
            {withQth && point !== null && (
              <Typography.Text type="secondary">
                {' '}
                {qthPending ? '查地名…' : qth === undefined ? '：没查到' : `：${qth}`}
              </Typography.Text>
            )}
          </Checkbox>
        )}
      </Space>
    </Modal>
  )
}
