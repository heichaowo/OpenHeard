import { useMemo } from 'react'
import { Card, Layout, Statistic, Table, Tag, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import type { Qso } from '@core'
import { useStore } from '../store'
import { utcMin } from '../time'

const CALLSIGN = 'BG0CG'

/** 只读。不显示待确认的内容，也不带任何写操作。 */
export default function PublicPage() {
  const { qsos, station } = useStore()

  const recent = useMemo(() => [...qsos].sort((a, b) => b.startAt - a.startAt), [qsos])
  const calls = useMemo(() => new Set(qsos.map((q) => q.call)).size, [qsos])

  const columns: TableColumnsType<Qso> = [
    { title: '时间 UTC', dataIndex: 'startAt', render: utcMin, width: 170 },
    { title: '呼号', dataIndex: 'call', width: 120 },
    { title: '波段', dataIndex: 'band', width: 80 },
    {
      title: '模式',
      dataIndex: 'mode',
      width: 90,
      render: (m: string) => <Tag>{m}</Tag>,
    },
    {
      title: 'QTH',
      key: 'qth',
      render: (_, q) => q.qth ?? '—',
    },
  ]

  return (
    <Layout className="public-page">
      <Layout.Content className="public-inner">
        <Typography.Title level={2} style={{ marginBottom: 0 }}>
          {CALLSIGN}
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          {[station.myQth, station.myGridsquare].filter(Boolean).join(' · ')}
        </Typography.Paragraph>

        <div className="stat-row">
          <Card  size="small">
            <Statistic title="通联总数" value={qsos.length} />
          </Card>
          <Card  size="small">
            <Statistic title="不同呼号" value={calls} />
          </Card>
          <Card  size="small">
            <Statistic
              title="最近一次"
              value={recent[0] ? utcMin(recent[0].startAt) : '—'}
              styles={{ content: { fontSize: 20 } }}
            />
          </Card>
        </div>

        <Typography.Title level={5}>最近通联</Typography.Title>
        <Card className="flush-card">
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={recent.slice(0, 20)}
          pagination={false}
          scroll={{ x: 600 }}
          locale={{ emptyText: '还没有通联' }}
        />
        </Card>

        <Typography.Paragraph type="secondary" style={{ marginTop: 24 }}>
          本页由 OpenHeard 自动记录并生成。
        </Typography.Paragraph>
      </Layout.Content>
    </Layout>
  )
}
