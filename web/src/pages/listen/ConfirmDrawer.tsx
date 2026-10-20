import { Button, Descriptions, Drawer, Form, Typography } from 'antd'
import type { FormInstance } from 'antd'
import { QsoFields } from '../../components/QsoFields'
import type { QsoFormValues } from '../../components/QsoFields'
import type { Conversation, MapProvider } from '../../api'
import type { Qso, QsoDraft, QsoField } from '@core'
import { useTime } from '../../useTime'
import { transcriptOf } from './ai'
import { ORIGIN_LABEL } from './model'

/**
 * 确认入库抽屉，待确认队列原来那一份原样搬过来：QsoFields、useRecall
 * 补的 QTH/网格提示、confirmDiscard 挡误触关闭，都是调用方（收听页）接的。
 * 这里只管画。
 */
export function ConfirmDrawer({
  editing,
  wide,
  form,
  recalledFrom,
  qsos,
  onValuesChange,
  submitting,
  onClose,
  onSubmit,
  mapProvider,
}: {
  /** ids 是打开时挑中的那几次，aiFilled 是草稿里哪几个字段是 AI 填的。 */
  editing: { conv: Conversation; ids: string[]; draft: QsoDraft; aiFilled: QsoField[] } | null
  wide: boolean
  form: FormInstance<QsoFormValues>
  recalledFrom?: string
  /** 呼号联想用，和快速补录同一份日志。 */
  qsos: Qso[]
  onValuesChange: (changed: Partial<QsoFormValues>) => void
  submitting: boolean
  onClose: () => void
  onSubmit: (values: QsoFormValues) => void
  mapProvider?: MapProvider
}) {
  const time = useTime()
  // 这次要入库的那几次发射里，听出了什么。没人声的那次转写是凭空编的，不列。
  const heard = (editing?.conv.activities ?? []).filter((a) => editing?.ids.includes(a.id) && transcriptOf(a) !== undefined)
  return (
    <Drawer
      title="确认入库"
      // 手机上 420 比屏幕还宽，antd 不会自己收，于是抽屉开着整页要横滚。
      width={wide ? 420 : '100%'}
      open={editing !== null}
      maskClosable={false}
      onClose={onClose}
      extra={
        <Button type="primary" loading={submitting} onClick={() => form.submit()}>
          入库
        </Button>
      }
    >
      {editing && (
        <>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label={`时间 ${time.label}`}>
              {time.at(editing.draft.startAt ?? editing.conv.startAt)}
            </Descriptions.Item>
            <Descriptions.Item label="频率">{editing.draft.freqMhz} MHz</Descriptions.Item>
            <Descriptions.Item label="波段">{editing.draft.band}</Descriptions.Item>
            <Descriptions.Item label="模式">{editing.draft.mode}</Descriptions.Item>
            <Descriptions.Item label="来源">{ORIGIN_LABEL[editing.conv.origin]}</Descriptions.Item>
          </Descriptions>
          {heard.length > 0 && (
            <div className="drawer-transcripts">
              <Typography.Text type="secondary">识别出的内容，仅供参考</Typography.Text>
              {heard.map((a) => (
                <div key={a.id} className="drawer-transcript">
                  <Typography.Text type="secondary" className="mono">
                    {time.atShort(a.startAt)} {a.mine ? '本台' : '对方'}
                  </Typography.Text>
                  <div>{transcriptOf(a)}</div>
                </div>
              ))}
            </div>
          )}
          <Form
            form={form}
            layout="vertical"
            onFinish={onSubmit}
            onValuesChange={onValuesChange}
            style={{ marginTop: 24 }}
          >
            <QsoFields recalledFrom={recalledFrom} qsos={qsos} mapProvider={mapProvider} aiFilled={editing.aiFilled} />
            {/* 让输入框里按回车也能提交，抽屉标题栏那个按钮在表单外面 */}
            <Button htmlType="submit" style={{ display: 'none' }} />
          </Form>
        </>
      )}
    </Drawer>
  )
}
