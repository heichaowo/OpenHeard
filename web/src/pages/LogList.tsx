import { useMemo, useState } from 'react'
import { App, Button, Flex, Input, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { adifFile, normalizeCallsign } from '@core'
import type { Qso } from '@core'
import { useStore } from '../store'
import { utcSec } from '../time'

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export default function LogList() {
  const { message } = App.useApp()
  const { qsos, removeQso } = useStore()
  const [search, setSearch] = useState('')

  const rows = useMemo(() => {
    const needle = normalizeCallsign(search)
    const matched = needle ? qsos.filter((q) => q.call.includes(needle)) : qsos
    return [...matched].sort((a, b) => b.startAt - a.startAt)
  }, [qsos, search])

  const exportAdif = () => {
    if (rows.length === 0) {
      message.warning('没有可导出的记录')
      return
    }
    download('openheard.adi', adifFile(rows))
    message.success(`导出 ${rows.length} 条`)
  }

  const columns: TableColumnsType<Qso> = [
    { title: '时间 UTC', dataIndex: 'startAt', render: utcSec, width: 190 },
    {
      title: '呼号',
      dataIndex: 'call',
      width: 120,
      render: (call: string) => <Typography.Text strong>{call}</Typography.Text>,
    },
    {
      title: '频率',
      dataIndex: 'freqMhz',
      width: 110,
      render: (f: number) => `${f} MHz`,
    },
    { title: '波段', dataIndex: 'band', width: 80 },
    {
      title: '模式',
      dataIndex: 'mode',
      width: 90,
      render: (m: string) => <Tag>{m}</Tag>,
    },
    {
      title: '报告 发/收',
      key: 'rst',
      width: 110,
      render: (_, q) => `${q.rstSent} / ${q.rstRcvd}`,
    },
    {
      title: '对方 QTH',
      key: 'their',
      render: (_, q) => [q.qth, q.gridsquare].filter(Boolean).join(' ') || '—',
    },
    {
      title: '来源',
      key: 'source',
      width: 90,
      render: (_, q) =>
        q.clusterId ? <Tag color="blue">自动</Tag> : <Tag>手工</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_, q) => (
        <Popconfirm title={`删除与 ${q.call} 的通联？`} onConfirm={() => removeQso(q.id)}>
          <Button type="link" danger>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ]

  return (
    <>
      <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 16 }}>
        <Space>
          <Input.Search
            allowClear
            placeholder="按呼号筛选"
            style={{ width: 220 }}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Typography.Text type="secondary">{rows.length} 条</Typography.Text>
        </Space>
        <Button onClick={exportAdif}>导出 ADIF</Button>
      </Flex>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={rows}
        scroll={{ x: 1000 }}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: '还没有通联' }}
        expandable={{
          rowExpandable: (q) => Boolean(q.note || q.myDevice),
          expandedRowRender: (q) => (
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary">
                本台 {[q.myQth, q.myGridsquare, q.myDevice, q.myAntenna, q.myPower]
                  .filter(Boolean)
                  .join(' · ')}
                {q.myHeightM === undefined ? '' : ` · 天线 ${q.myHeightM} m`}
              </Typography.Text>
              {q.note && <Typography.Text>{q.note}</Typography.Text>}
            </Space>
          ),
        }}
      />
    </>
  )
}
