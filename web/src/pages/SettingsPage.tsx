import { useCallback, useEffect, useState } from 'react'
import { App, Alert, Button, Card, Form, Input, InputNumber, Select, Space, Typography } from 'antd'
import { api, errorText } from '../api'
import type { Settings } from '../api'
import { AsyncContent } from '../components/AsyncContent'
import { PageHeader } from '../components/PageHeader'
import { useStore } from '../store'

const MODES = [
  { value: 'FM', label: 'FM' },
  { value: 'DMR', label: 'DMR' },
]

export default function SettingsPage() {
  const { message } = App.useApp()
  const { refresh } = useStore()
  const [form] = Form.useForm<Settings>()
  const [settings, setSettings] = useState<Settings | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = await api.settings()
      setSettings(s)
      form.setFieldsValue(s)
      setError(undefined)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [form])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
  }, [load])

  const save = async (values: Settings) => {
    setSaving(true)
    try {
      const saved = await api.saveSettings(values)
      setSettings(saved)
      form.setFieldsValue(saved)
      message.success('存好了，守护进程会自己跟上')
      // 本台信息和信道表是全局 store 里的，存完要重拉。
      await refresh()
    } catch (e) {
      message.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageHeader
        title="设置"
        note="改完直接存，不用登录到机器上。守护进程盯着配置文件，换频率大约要几秒重新校准静噪。"
        actions={
          <Button type="primary" loading={saving} onClick={() => form.submit()}>
            保存
          </Button>
        }
      />
      <AsyncContent loading={loading} error={error} empty={settings === undefined} onRetry={load}>
        <Form form={form} layout="vertical" onFinish={save}>
          <Card size="small" title="模拟守听" style={{ marginBottom: 16 }}>
            {settings?.analog === undefined ? (
              <Alert
                type="info"
                showIcon
                message="配置里没有 analog 那一段，这台机器不守听模拟信号。加上它要改配置文件并重启守护进程。"
              />
            ) : (
              <Space wrap align="start">
                <Form.Item
                  name={['analog', 'freqMhz']}
                  label="频率 MHz"
                  rules={[{ required: true, message: '频率必填' }]}
                  extra="只能是 2m（144–148）或 70cm（420–450）"
                >
                  <InputNumber style={{ width: 140 }} step={0.0125} />
                </Form.Item>
                <Form.Item
                  name={['analog', 'channel']}
                  label="信道名"
                  rules={[{ required: true, message: '信道名必填' }]}
                  extra="进采集记录和发射行的那个名字"
                >
                  <Input style={{ width: 180 }} />
                </Form.Item>
                <Form.Item name={['analog', 'gainDb']} label="增益 dB" extra="缺省 32.8">
                  <InputNumber style={{ width: 120 }} step={0.1} />
                </Form.Item>
                <Form.Item
                  name={['analog', 'myUnitId']}
                  label="本台 MDC unit ID"
                  extra="十六进制，缺了就判不出哪次是本台"
                >
                  <Input style={{ width: 140 }} placeholder="6460" />
                </Form.Item>
              </Space>
            )}
          </Card>

          <Card size="small" title="本台" style={{ marginBottom: 16 }}>
            <Space wrap align="start">
              <Form.Item name={['station', 'myCallsign']} label="呼号">
                <Input style={{ width: 120 }} />
              </Form.Item>
              <Form.Item name={['station', 'myGridsquare']} label="网格">
                <Input style={{ width: 100 }} />
              </Form.Item>
              <Form.Item name={['station', 'myQth']} label="QTH">
                <Input style={{ width: 140 }} />
              </Form.Item>
              <Form.Item name={['station', 'myDevice']} label="设备">
                <Input style={{ width: 180 }} />
              </Form.Item>
              <Form.Item name={['station', 'myAntenna']} label="天线">
                <Input style={{ width: 180 }} />
              </Form.Item>
              <Form.Item name={['station', 'myPower']} label="功率">
                <Input style={{ width: 100 }} />
              </Form.Item>
              <Form.Item name={['station', 'myHeightM']} label="天线高度（米）">
                <InputNumber style={{ width: 140 }} />
              </Form.Item>
              <Form.Item
                name={['station', 'networkFreqMhz']}
                label="网络记账频率"
                extra="BrandMeister 的会话没有射频频率"
              >
                <InputNumber style={{ width: 160 }} step={0.0125} />
              </Form.Item>
            </Space>
          </Card>

          <Card size="small" title="频谱表" style={{ marginBottom: 16 }}>
            <Typography.Paragraph type="secondary">
              快速补录的信道下拉用它。频率本来就能手打，这里只是省事。
            </Typography.Paragraph>
            <Form.List name="channels">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field) => (
                    <Space key={field.key} align="start" wrap>
                      <Form.Item name={[field.name, 'name']} rules={[{ required: true, message: '名字必填' }]}>
                        <Input style={{ width: 180 }} placeholder="439.525 中继" />
                      </Form.Item>
                      <Form.Item name={[field.name, 'freqMhz']} rules={[{ required: true, message: '频率必填' }]}>
                        <InputNumber style={{ width: 130 }} step={0.0125} placeholder="439.525" />
                      </Form.Item>
                      <Form.Item name={[field.name, 'mode']} rules={[{ required: true }]}>
                        <Select style={{ width: 100 }} options={MODES} />
                      </Form.Item>
                      <Button type="link" danger onClick={() => remove(field.name)}>
                        删掉
                      </Button>
                    </Space>
                  ))}
                  <Button onClick={() => add({ mode: 'FM' })}>加一条</Button>
                </>
              )}
            </Form.List>
          </Card>

          <Card size="small" title="BrandMeister 查询">
            <Typography.Paragraph type="secondary">
              每条规则单独一次查询，不要用 OR 合并，`amount` 是合并去重后的全局上限，热闹的话务组会把安静的饿死。
              数值字段必须是数字，传字符串会静默返回空集。
            </Typography.Paragraph>
            <Form.List name="queries">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field) => (
                    <Space key={field.key} align="start" wrap>
                      <Form.Item name={[field.name, 'key']} rules={[{ required: true, message: '名字必填' }]}>
                        <Input style={{ width: 150 }} placeholder="dst:46001" />
                      </Form.Item>
                      <Form.Item name={[field.name, 'rule', 'id']} rules={[{ required: true }]}>
                        <Select
                          style={{ width: 160 }}
                          options={[
                            { value: 'DestinationID', label: '话务组 DestinationID' },
                            { value: 'SourceID', label: '发射方 SourceID' },
                          ]}
                        />
                      </Form.Item>
                      <Form.Item name={[field.name, 'rule', 'operator']} initialValue="equal" hidden>
                        <Input />
                      </Form.Item>
                      <Form.Item name={[field.name, 'rule', 'value']} rules={[{ required: true, message: '必填' }]}>
                        <InputNumber style={{ width: 130 }} placeholder="46001" />
                      </Form.Item>
                      <Form.Item name={[field.name, 'amount']} rules={[{ required: true }]}>
                        <InputNumber style={{ width: 110 }} placeholder="200" addonBefore="取" />
                      </Form.Item>
                      <Form.Item name={[field.name, 'intervalS']} rules={[{ required: true }]}>
                        <InputNumber style={{ width: 130 }} placeholder="900" addonAfter="秒" />
                      </Form.Item>
                      <Button type="link" danger onClick={() => remove(field.name)}>
                        删掉
                      </Button>
                    </Space>
                  ))}
                  <Button
                    onClick={() =>
                      add({ rule: { id: 'DestinationID', operator: 'equal' }, amount: 200, intervalS: 900 })
                    }
                  >
                    加一条
                  </Button>
                </>
              )}
            </Form.List>
          </Card>
        </Form>
      </AsyncContent>
    </>
  )
}
