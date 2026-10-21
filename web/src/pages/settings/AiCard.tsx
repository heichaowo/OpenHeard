import { Alert, Card, Form, Input, InputNumber, Select, Space, Switch, Typography } from 'antd'
import type { FormInstance } from 'antd'
import type { AsrProvider, TextProvider, VadProvider } from '../../api'
import { SecretInput } from './secret'
import type { FormValues, SecretState } from './model'

const VAD_OPTIONS: { value: VadProvider; label: string }[] = [
  { value: 'local', label: '本机（Silero VAD）' },
  { value: 'off', label: '关闭' },
]

const ASR_OPTIONS: { value: AsrProvider; label: string }[] = [
  { value: 'local', label: '本机（whisper-cli）' },
  { value: 'openai-transcriptions', label: '云端：OpenAI 兼容转写接口' },
  { value: 'chat-audio', label: '云端：对话式音频接口（MiMo、通义）' },
  { value: 'off', label: '关闭' },
]

const TEXT_OPTIONS: { value: TextProvider; label: string }[] = [
  { value: 'local', label: '本机（llama-server）' },
  { value: 'openai-chat', label: '云端：OpenAI 兼容对话接口' },
  { value: 'off', label: '关闭' },
]

/**
 * extraBody 的输入框是文本，保存时才解析成对象。识别关着时整卡藏起来但字段还挂着，
 * 这时不校验，否则藏着的错会无声无息地拦下整个保存。
 */
const jsonObject = (on: boolean) => async (_: unknown, v?: string) => {
  if (!on || v === undefined || v.trim() === '') return
  let parsed: unknown
  try {
    parsed = JSON.parse(v)
  } catch {
    throw new Error('不是合法的 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('要写成 JSON 对象，例如 {"thinking":{"type":"disabled"}}')
  }
}

/** 云端的四项：地址、模型名、key、额外参数。识别和提取共用。 */
function CloudFields({
  step,
  on,
  keyLabel,
  isSet,
  secret,
  onSecret,
  baseUrlExtra,
}: {
  step: 'asr' | 'text'
  on: boolean
  keyLabel: string
  isSet: boolean
  secret: SecretState
  onSecret: (s: SecretState) => void
  baseUrlExtra?: string
}) {
  const name = step === 'asr' ? '识别' : '提取'
  return (
    <>
      <Form.Item
        name={['ai', step, 'baseUrl']}
        label={`${name} 接口地址`}
        extra={baseUrlExtra}
        rules={on ? [{ required: true, message: '地址必填' }] : []}
      >
        <Input placeholder="https://api.example.com/v1" />
      </Form.Item>
      <Space wrap align="start">
        <Form.Item
          name={['ai', step, 'model']}
          label={`${name} 模型名`}
          rules={on ? [{ required: true, message: '模型名必填' }] : []}
        >
          <Input style={{ width: 220 }} />
        </Form.Item>
        <Form.Item label={`${name} key`}>
          <SecretInput label={keyLabel} isSet={isSet} state={secret} onChange={onSecret} />
        </Form.Item>
      </Space>
      <Form.Item
        name={['extra', step]}
        label={`${name} 额外参数`}
        extra={'原样并进请求体，写成 JSON 对象。关掉思考模式之类的厂商参数放这里，例如 {"thinking":{"type":"disabled"}}。'}
        rules={[{ validator: jsonObject(on) }]}
      >
        <Input.TextArea rows={2} spellCheck={false} className="mono" />
      </Form.Item>
    </>
  )
}

/**
 * 识别卡：人声判断、识别、提取三块。三步的次序是固定的：先判断有没有人声，
 * 再转写，再从转写里提取呼号等字段。关着时整卡藏起来但不卸载，原来的设置都留着。
 */
export function AiCard({
  form,
  on,
  keysSet,
  secrets,
  onSecret,
  problem,
}: {
  form: FormInstance<FormValues>
  /** 配置文件里 ai 段写坏了，坏在哪。 */
  problem?: string
  /** 总开关此刻开着没有。 */
  on: boolean
  keysSet: { asr: boolean; text: boolean }
  secrets: { asr: SecretState; text: SecretState }
  onSecret: (k: 'asr' | 'text', s: SecretState) => void
}) {
  const vad = Form.useWatch(['ai', 'vad', 'provider'], form) as VadProvider | undefined
  const asr = Form.useWatch(['ai', 'asr', 'provider'], form) as AsrProvider | undefined
  const text = Form.useWatch(['ai', 'text', 'provider'], form) as TextProvider | undefined
  const asrCloud = asr === 'openai-transcriptions' || asr === 'chat-audio'

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space>
          识别
          <Form.Item name={['ai', 'enabled']} valuePropName="checked" noStyle>
            <Switch aria-label="识别开关" />
          </Form.Item>
        </Space>
      }
    >
      {problem !== undefined && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="配置文件里的 ai 段有问题，现在按关着处理"
          description={`${problem}。下面是缺省值，不是文件里写的。保存这一卡会替换文件里的整个 ai 段，包括里面的 key。`}
        />
      )}
      {!on && (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          识别关着。打开后才能改，原来的设置都留着。
        </Typography.Paragraph>
      )}
      <div style={{ display: on ? undefined : 'none' }}>
        <Typography.Paragraph type="secondary">
          守护进程从新到旧一条条做：先判断有没有人声，再转写，再从转写里提取呼号、QTH 和报告。
          提取出的只是候选，界面上标明是 AI 填的，入库由人决定。
        </Typography.Paragraph>

        <Typography.Title level={5}>人声判断</Typography.Title>
        <Form.Item
          name={['ai', 'vad', 'provider']}
          label="人声判断方式"
          extra="只在本机跑，没有云端可选。关掉的话每段录音都送去转写，空按会被转成「字幕」之类凭空编出来的字。"
        >
          <Select<VadProvider> options={VAD_OPTIONS} style={{ maxWidth: 320 }} aria-label="人声判断方式" />
        </Form.Item>
        {vad === 'local' && (
          <>
            <Form.Item name={['ai', 'vad', 'binPath']} label="VAD 程序路径">
              <Input placeholder="/opt/homebrew/bin/whisper-vad-speech-segments" />
            </Form.Item>
            <Space wrap align="start">
              <Form.Item name={['ai', 'vad', 'modelPath']} label="VAD 模型路径">
                <Input style={{ width: 320 }} placeholder="./models/ggml-silero-v5.1.2.bin" />
              </Form.Item>
              <Form.Item name={['ai', 'vad', 'threshold']} label="VAD 阈值" extra="0 到 1，越高越严">
                <InputNumber min={0} max={1} step={0.05} style={{ width: 120 }} />
              </Form.Item>
            </Space>
          </>
        )}

        <Typography.Title level={5}>识别</Typography.Title>
        <Form.Item name={['ai', 'asr', 'provider']} label="识别方式">
          <Select<AsrProvider>
            options={ASR_OPTIONS}
            style={{ maxWidth: 360 }}
            aria-label="识别方式"
            onChange={(v) => {
              // 提取要有转写才有东西可提，识别关了提取也只能关。
              if (v === 'off') form.setFieldValue(['ai', 'text', 'provider'], 'off')
            }}
          />
        </Form.Item>
        {asr === 'local' && (
          <>
            <Form.Item name={['ai', 'asr', 'binPath']} label="识别 程序路径">
              <Input placeholder="/opt/homebrew/bin/whisper-cli" />
            </Form.Item>
            <Form.Item name={['ai', 'asr', 'modelPath']} label="识别 模型路径">
              <Input placeholder="./models/ggml-large-v3-turbo-q5_0.bin" />
            </Form.Item>
          </>
        )}
        {asrCloud && (
          <CloudFields
            step="asr"
            on={on}
            keyLabel="识别 key"
            isSet={keysSet.asr}
            secret={secrets.asr}
            onSecret={(s) => onSecret('asr', s)}
            baseUrlExtra={
              asr === 'openai-transcriptions'
                ? '智谱的转写接口只收 30 秒以内的录音，更长的录音会失败。'
                : undefined
            }
          />
        )}
        {asr !== 'off' && asr !== undefined && (
          <>
            <Form.Item name={['ai', 'asr', 'language']} label="识别 语言">
              <Input style={{ width: 120 }} placeholder="zh" />
            </Form.Item>
            <Form.Item
              name={['ai', 'asr', 'prompt']}
              label="提示词"
              extra="不加提示词时，5 段里约有 2 段转成繁体而且没有标点。加了「以下是普通话的句子。」之后全是简体、有标点，但英文会被带偏：CQTEST 会被转成「QQ赛」，而呼号正是英文字母。留空就是不加。"
            >
              <Input.TextArea rows={2} />
            </Form.Item>
          </>
        )}

        <Typography.Title level={5}>提取</Typography.Title>
        <Form.Item
          name={['ai', 'text', 'provider']}
          label="提取方式"
          extra={asr === 'off' ? '识别关着，提取也只能关。' : undefined}
        >
          <Select<TextProvider>
            options={TEXT_OPTIONS.map((o) => ({ ...o, disabled: asr === 'off' && o.value !== 'off' }))}
            style={{ maxWidth: 320 }}
            aria-label="提取方式"
          />
        </Form.Item>
        {text === 'local' && (
          <>
            <Form.Item name={['ai', 'text', 'binPath']} label="提取 程序路径">
              <Input placeholder="/opt/homebrew/bin/llama-server" />
            </Form.Item>
            <Form.Item name={['ai', 'text', 'modelPath']} label="提取 模型路径">
              <Input placeholder="./models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf" />
            </Form.Item>
            <Space wrap align="start">
              <Form.Item name={['ai', 'text', 'port']} label="提取 端口">
                <InputNumber min={1} max={65535} style={{ width: 120 }} />
              </Form.Item>
              <Form.Item
                name={['ai', 'text', 'idleUnloadS']}
                label="闲多少秒卸掉模型"
                extra="这台机器内存紧，闲着就把模型卸掉"
              >
                <InputNumber min={0} style={{ width: 120 }} />
              </Form.Item>
            </Space>
          </>
        )}
        {text === 'openai-chat' && (
          <CloudFields
            step="text"
            on={on}
            keyLabel="提取 key"
            isSet={keysSet.text}
            secret={secrets.text}
            onSecret={(s) => onSecret('text', s)}
          />
        )}
      </div>
    </Card>
  )
}
