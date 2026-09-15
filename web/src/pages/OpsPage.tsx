import { useCallback, useEffect, useState } from 'react'
import { Alert, Card, Descriptions, Statistic, Table, Tag, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { ApiError, api } from '../api'
import type { Ops, PollRow } from '../api'
import { AsyncContent } from '../components/AsyncContent'
import { PageHeader } from '../components/PageHeader'
import { utcSec } from '../time'

/** 运维数据自己拉，不进全局 store：只有这一页要，刷新频率也不一样。 */
const POLL_MS = 20000

const ORIGINS: Record<string, string> = {
  brandmeister: 'BrandMeister',
  'sdr-fm': '模拟接收机',
  'sdr-dmr': '数字接收机',
}

const bytes = (n?: number) =>
  n === undefined ? '—' : `${(n / 1e9).toFixed(1)} GB`

const ago = (now: number, at?: number) =>
  at === undefined ? '还没有' : `${now - at} 秒前`

export default function OpsPage() {
  const [ops, setOps] = useState<Ops | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setOps(await api.ops())
      setError(undefined)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // setState 都在 await 之后，规则认不出异步这一层。拉后端正是 effect 该做的事。
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const columns: TableColumnsType<PollRow> = [
    { title: '时间 UTC', dataIndex: 'at', render: utcSec, width: 190 },
    {
      title: '来源',
      dataIndex: 'queryKey',
      width: 180,
      render: (k: string) => <span className="mono">{k}</span>,
    },
    {
      title: '取回 / 解析 / 写入',
      key: 'counts',
      width: 170,
      render: (_, r) => (
        <span className="mono">
          {r.fetched} / {r.parsed} / {r.written}
        </span>
      ),
    },
    { title: '耗时', dataIndex: 'ms', width: 90, render: (n: number) => `${n} ms` },
    {
      title: '结果',
      key: 'ok',
      render: (_, r) =>
        r.ok ? (
          <Tag color="green">正常</Tag>
        ) : (
          <>
            <Tag color="red">失败</Tag>
            <span className="mono">{r.errorMsg}</span>
          </>
        ),
    },
  ]

  return (
    <>
      <PageHeader
        title="运维"
        note="无人值守时这几个数字是唯一能读到的东西。取回多少行、解析出多少行、写入多少行分开记，来源改字段时才看得出来。"
      />
      <AsyncContent
        loading={loading}
        error={error}
        empty={ops === undefined}
        emptyText="拿不到运维数据"
        onRetry={load}
      >
        {ops && (
          <>
            {ops.health.ok ? (
              <Alert
                type="success"
                showIcon
                style={{ marginBottom: 16 }}
                message={`一切正常，最近一次采集在 ${ago(ops.now, ops.health.lastPollAt)}`}
              />
            ) : (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                message="有问题"
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                    {ops.health.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                }
              />
            )}

            <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
              <Card size="small">
                <Statistic title="采集到的发射" value={ops.health.activityCount} />
              </Card>
              <Card size="small">
                <Statistic title="正式通联" value={ops.health.qsoCount} />
              </Card>
              <Card size="small">
                <Statistic
                  title="最近一次采集"
                  value={ago(ops.now, ops.health.lastPollAt)}
                  styles={{ content: { fontSize: 20 } }}
                />
              </Card>
              <Card size="small">
                <Statistic
                  title="磁盘剩余"
                  value={bytes(ops.health.freeBytes)}
                  styles={{ content: { fontSize: 20 } }}
                />
              </Card>
            </div>

            <Card size="small" title="采集来源" style={{ marginBottom: 16 }}>
              <Descriptions size="small" column={1} bordered>
                {ops.activities.map((a) => (
                  <Descriptions.Item key={a.origin} label={ORIGINS[a.origin] ?? a.origin}>
                    {a.n} 条，最近一条 {utcSec(a.latest)}
                  </Descriptions.Item>
                ))}
                {ops.activities.length === 0 && (
                  <Descriptions.Item label="还没有">一条都没采到</Descriptions.Item>
                )}
              </Descriptions>
            </Card>

            <Card size="small" title="配置" style={{ marginBottom: 16 }}>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="聚类间隔阈值">
                  {ops.clusterGapS} 秒
                  <Typography.Text type="secondary"> （要用真实流量实测定下来）</Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="发射保留期">{ops.retentionDays} 天</Descriptions.Item>
                {ops.queries.map((q) => (
                  <Descriptions.Item key={q.key} label={<span className="mono">{q.key}</span>}>
                    每 {q.intervalS} 秒一次，每次取 {q.amount} 行
                  </Descriptions.Item>
                ))}
              </Descriptions>
            </Card>

            <Card className="flush-card" title="最近的采集">
              <Table
                rowKey={(r) => `${r.queryKey}-${r.at}`}
                size="small"
                columns={columns}
                dataSource={ops.polls}
                pagination={false}
                scroll={{ x: 760, y: 420 }}
                locale={{ emptyText: '还没有采集记录' }}
              />
            </Card>
          </>
        )}
      </AsyncContent>
    </>
  )
}
