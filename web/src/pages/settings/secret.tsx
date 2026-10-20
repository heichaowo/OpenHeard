import { Button, Input, Space, Tag, Typography } from 'antd'
import { NO_SECRET } from './model'
import type { SecretState } from './model'

export function SecretInput({
  label,
  isSet,
  state,
  onChange,
}: {
  label: string
  /** 服务端回的：现在有没有存着。 */
  isSet: boolean
  state: SecretState
  onChange: (s: SecretState) => void
}) {
  const clearing = isSet && state.clear && state.value === ''
  return (
    <div>
      <Input.Password
        aria-label={label}
        autoComplete="new-password"
        value={state.value}
        placeholder={clearing ? '保存后清除' : isSet ? '已设置，输入新的才会替换' : '还没设'}
        onChange={(e) => onChange({ value: e.target.value, clear: false })}
      />
      <Space size={4} style={{ marginTop: 4 }}>
        {isSet && !clearing && <Tag color="green">已设置</Tag>}
        {clearing && <Tag color="orange">保存后清除</Tag>}
        {isSet && !clearing && (
          <Button type="link" size="small" onClick={() => onChange({ value: '', clear: true })}>
            清除
          </Button>
        )}
        {clearing && (
          <Button type="link" size="small" onClick={() => onChange(NO_SECRET)}>
            不清除了
          </Button>
        )}
        {!isSet && <Typography.Text type="secondary">只写不读，存下之后页面上看不到它。</Typography.Text>}
      </Space>
    </div>
  )
}
