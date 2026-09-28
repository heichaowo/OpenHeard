import { SearchOutlined } from '@ant-design/icons'
import { Input, Typography } from 'antd'

/**
 * 呼号搜索框。至少 2 个字符才真的触发搜索——由调用方按输入去抖之后判断，
 * 这里只管输入本身和「已经加载了多少条」这句提示。
 */
export function SearchBox({
  value,
  onChange,
  searching,
  loadedCount,
}: {
  value: string
  onChange: (v: string) => void
  searching: boolean
  loadedCount: number
}) {
  return (
    <div className="listen-search">
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder="搜呼号，至少 2 个字符，跨整个保留期"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {searching && (
        <Typography.Text type="secondary" className="listen-search-count">
          已加载 {loadedCount} 条
        </Typography.Text>
      )}
    </div>
  )
}
