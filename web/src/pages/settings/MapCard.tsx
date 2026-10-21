import { Alert, Card, Form, Input, Radio, Typography } from 'antd'
import type { FormInstance } from 'antd'
import type { MapProvider } from '../../api'
import { SecretInput } from './secret'
import type { FormValues, SecretState } from './model'

/** 地图卡。选好之后收听页、日志、快速补录和本台网格旁边的「在地图上选」才可用。 */
export function MapCard({
  form,
  codeSet,
  secret,
  onSecret,
  problem,
}: {
  form: FormInstance<FormValues>
  /** 配置文件里 map 段写坏了，坏在哪。 */
  problem?: string
  codeSet: boolean
  secret: SecretState
  onSecret: (s: SecretState) => void
}) {
  const provider = Form.useWatch(['map', 'provider'], form) as MapProvider | undefined
  return (
    <Card size="small" title="地图" style={{ marginBottom: 16 }}>
      {problem !== undefined && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="配置文件里的 map 段有问题，现在按不用地图处理"
          description={`${problem}。下面是缺省值，不是文件里写的。保存这一卡会替换文件里的整个 map 段，包括里面的 key。`}
        />
      )}
      <Typography.Paragraph type="secondary">
        填对方网格时可以在地图上点。网格按 WGS-84 算，高德给的坐标会先换回来再算。
      </Typography.Paragraph>
      <Form.Item name={['map', 'provider']} label="用哪个地图">
        <Radio.Group
          options={[
            { value: 'amap', label: '高德' },
            { value: 'osm', label: 'OpenStreetMap' },
            { value: 'none', label: '不用地图' },
          ]}
        />
      </Form.Item>
      {provider === 'osm' && (
        <Typography.Paragraph type="secondary">
          OpenStreetMap 不要 key，但国内可能打不开。地名搜索每秒最多一次，只在按回车或搜索时才搜。
        </Typography.Paragraph>
      )}
      {provider === 'amap' && (
        <>
          <Typography.Paragraph type="secondary">
            要自己申请：在 console.amap.com 创建应用，加一个服务平台是「Web端(JS API)」的 key，会同时给出安全密钥。
            2021 年 12 月 2 日以后创建的 key 必须配安全密钥。安全密钥只存在 api 里，不进页面，
            高德的 Web 服务请求由 api 代理。
          </Typography.Paragraph>
          <Form.Item
            name={['map', 'amapKey']}
            label="高德 key"
            extra="这个 key 本来就会出现在页面里，所以照常显示。"
            rules={[{ validator: async (_, v?: string) => (provider === 'amap' && !v?.trim() ? Promise.reject(new Error('key 必填')) : undefined) }]}
          >
            <Input placeholder="Web端(JS API) 的 key" />
          </Form.Item>
          <Form.Item label="高德安全密钥">
            <SecretInput label="高德安全密钥" isSet={codeSet} state={secret} onChange={onSecret} />
          </Form.Item>
        </>
      )}
    </Card>
  )
}
