import { useCallback, useEffect, useState } from "react";
import {
  App,
  Alert,
  Button,
  Card,
  Form,
  Grid,
  Input,
  InputNumber,
  Select,
  Space,
  Typography,
} from "antd";
import type { FormInstance } from "antd";
import { MAX_CHANNELS, MAX_SPAN_HZ, bandOf, planTuning } from "@core";
import { api, errorText } from "../api";
import type { Settings } from "../api";
import { AsyncContent } from "../components/AsyncContent";
import { PageHeader } from "../components/PageHeader";
import { useStore } from "../store";

const filled = (v: unknown) =>
  v !== undefined &&
  v !== null &&
  v !== "" &&
  !(Array.isArray(v) && v.length === 0);

type ChannelRow = { freqMhz?: number | null; channel?: string };

/** 这几个频率里第一个不在 2m 或 70cm 的，没有就是 undefined。 */
const outOfBand = (freqsHz: number[]) =>
  freqsHz.find((f) => bandOf(f / 1e6) === undefined);

/** 已经填了频率的那几行，换成 Hz。 */
const freqsOf = (rows: ChannelRow[] | undefined) =>
  (rows ?? [])
    .map((r) => r?.freqMhz)
    .filter((f): f is number => typeof f === "number")
    .map((f) => Math.round(f * 1e6));

/**
 * 信道表整体讲不讲得通。每一行的必填由那一行自己管。
 *
 * 没配过模拟守听的机器，这一栏整个空着是正常的。别的几格都空、信道表也空，
 * 就不拦，否则只改本台信息也存不下去。
 */
const checkChannels =
  (form: FormInstance<Settings>) => async (_: unknown, rows?: ChannelRow[]) => {
    const others = { ...(form.getFieldValue("analog") ?? {}), channels: [] };
    const started = (rows ?? []).length > 0 || Object.values(others).some(filled);
    if (!started) return;
    if ((rows ?? []).length === 0) throw new Error("至少要有一个信道");
    const names = (rows ?? []).map((r) => r?.channel).filter(filled);
    if (new Set(names).size !== names.length) throw new Error("信道名不能重复");
    const freqs = freqsOf(rows);
    const off = outOfBand(freqs);
    if (off !== undefined) throw new Error(`${off / 1e6} MHz 不在 2m 或 70cm 段内`);
    if (freqs.length < (rows ?? []).length) return;
    const plan = planTuning(freqs);
    if (!plan.ok) throw new Error(plan.problem);
  };

/** 这组信道一支接收机怎么收。填的时候就看得见，不用存了才知道不行。 */
function TuningHint({ rows }: { rows?: ChannelRow[] }) {
  const freqs = freqsOf(rows);
  if (freqs.length === 0) return null;
  // 和存的时候 api 那边的校验一致。接收机收得下，不等于这是业余波段。
  const off = outOfBand(freqs);
  if (off !== undefined) {
    return (
      <Typography.Paragraph type="danger" style={{ marginTop: 8 }}>
        {off / 1e6} MHz 不在 2m（144–148）或 70cm（420–450）段内。
      </Typography.Paragraph>
    );
  }
  const plan = planTuning(freqs);
  const span = Math.max(...freqs) - Math.min(...freqs);
  return (
    <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
      一支接收机同时守最多 {MAX_CHANNELS} 个信道，最高和最低相差不超过{" "}
      {MAX_SPAN_HZ / 1e6} MHz。
      {plan.ok ? (
        <>
          {" "}
          现在相差 {span / 1000} kHz，接收机调到 {plan.plan.centerHz / 1e6}{" "}
          MHz，采样率 {plan.plan.sampleRate / 1e6} MHz。
        </>
      ) : (
        <Typography.Text type="danger"> {plan.problem}</Typography.Text>
      )}
    </Typography.Paragraph>
  );
}

const MODES = [
  { value: "FM", label: "FM" },
  { value: "DMR", label: "DMR" },
];

export default function SettingsPage() {
  const { message } = App.useApp();
  const { refresh } = useStore();
  const [form] = Form.useForm<Settings>();
  const [settings, setSettings] = useState<Settings | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const wide = Grid.useBreakpoint().md ?? true;
  const channelRows = Form.useWatch(["analog", "channels"], form) as
    | ChannelRow[]
    | undefined;

  const load = useCallback(async () => {
    try {
      const s = await api.settings();
      setSettings(s);
      form.setFieldsValue(s);
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void load();
  }, [load]);

  const save = async (values: Settings) => {
    setSaving(true);
    try {
      const saved = await api.saveSettings(values);
      setSettings(saved);
      form.setFieldsValue(saved);
      message.success("存好了，守护进程会自己跟上");
      // 本台信息和信道表是全局 store 里的，存完要重拉。
      await refresh();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="设置"
        note="改完直接存，不用登录到机器上。守护进程盯着配置文件，换频率大约要几秒重新校准静噪。"
        actions={
          wide ? (
            <Button
              type="primary"
              loading={saving}
              onClick={() => form.submit()}
            >
              保存
            </Button>
          ) : undefined
        }
      />
      <AsyncContent
        loading={loading}
        error={error}
        empty={settings === undefined}
        onRetry={load}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={save}
          // 信道表整体的规则挂在 Form.List 上，改某一行时不会自己重跑。
          // 不补这一下，信道名重复要点了保存才看得到。
          onValuesChange={(changed: Partial<Settings>) => {
            if (changed.analog?.channels !== undefined) {
              form
                .validateFields([["analog", "channels"]])
                .catch(() => undefined);
            }
          }}
        >
          <Card size="small" title="模拟守听" style={{ marginBottom: 16 }}>
            {settings?.analog === undefined && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message="这台机器还没有配模拟守听。在这里填好保存，守护进程重启一次就会开始守听。"
              />
            )}
            <Typography.Paragraph type="secondary">
              要守的信道。频率只能是 2m（144–148）或 70cm（420–450），信道名进采集记录和发射行。
            </Typography.Paragraph>
            <Form.List
              name={["analog", "channels"]}
              rules={[{ validator: checkChannels(form) }]}
            >
              {(fields, { add, remove }, { errors }) => (
                <>
                  {fields.map((field) => (
                    <Space key={field.key} align="start" wrap>
                      <Form.Item
                        name={[field.name, "freqMhz"]}
                        rules={[{ required: true, message: "频率必填" }]}
                      >
                        <InputNumber
                          style={{ width: 140 }}
                          step={0.0125}
                          placeholder="438.500"
                          aria-label="信道频率 MHz"
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "channel"]}
                        rules={[{ required: true, message: "信道名必填" }]}
                      >
                        <Input
                          style={{ width: 180 }}
                          placeholder="438.500 中继"
                          aria-label="信道名"
                        />
                      </Form.Item>
                      <Button
                        type="link"
                        danger
                        onClick={() => remove(field.name)}
                      >
                        删掉
                      </Button>
                    </Space>
                  ))}
                  <Button
                    onClick={() => add({})}
                    disabled={fields.length >= MAX_CHANNELS}
                  >
                    加一个信道
                  </Button>
                  <Form.ErrorList errors={errors} />
                  <TuningHint rows={channelRows} />
                </>
              )}
            </Form.List>
            <Space wrap align="start" style={{ marginTop: 16 }}>
              <Form.Item
                name={["analog", "gainDb"]}
                label="增益 dB"
                extra="缺省 32.8，收不到时先试 49.6"
              >
                <InputNumber style={{ width: 120 }} step={0.1} />
              </Form.Item>
              <Form.Item
                name={["analog", "myUnitId"]}
                label="本台 MDC unit ID"
                extra="十六进制，缺了就判不出哪次是本台"
              >
                <Input style={{ width: 140 }} placeholder="6460" />
              </Form.Item>
              <Form.Item
                name={["analog", "openMarginDb"]}
                label="静噪打开余量 dB"
                extra="缺省 12。调小听得到更弱的信号，也更容易被噪声误开"
              >
                <InputNumber style={{ width: 120 }} step={0.5} />
              </Form.Item>
              <Form.Item
                name={["analog", "closeMarginDb"]}
                label="静噪关闭余量 dB"
                extra="缺省 7，要比打开余量小至少 2"
              >
                <InputNumber style={{ width: 120 }} step={0.5} />
              </Form.Item>
            </Space>
          </Card>

          <Card size="small" title="本台" style={{ marginBottom: 16 }}>
            <Space wrap align="start">
              <Form.Item name={["station", "myCallsign"]} label="呼号">
                <Input style={{ width: 120 }} />
              </Form.Item>
              <Form.Item name={["station", "myGridsquare"]} label="网格">
                <Input style={{ width: 100 }} />
              </Form.Item>
              <Form.Item name={["station", "myQth"]} label="QTH">
                <Input style={{ width: 140 }} />
              </Form.Item>
              <Form.Item name={["station", "myDevice"]} label="设备">
                <Input style={{ width: 180 }} />
              </Form.Item>
              <Form.Item name={["station", "myAntenna"]} label="天线">
                <Input style={{ width: 180 }} />
              </Form.Item>
              <Form.Item name={["station", "myPower"]} label="功率">
                <Input style={{ width: 100 }} />
              </Form.Item>
              <Form.Item name={["station", "myHeightM"]} label="天线高度（米）">
                <InputNumber style={{ width: 140 }} />
              </Form.Item>
              <Form.Item
                name={["station", "networkFreqMhz"]}
                label="网络记账频率 MHz"
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
                      <Form.Item
                        name={[field.name, "name"]}
                        rules={[{ required: true, message: "名字必填" }]}
                      >
                        <Input
                          style={{ width: 180 }}
                          placeholder="439.525 中继"
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "freqMhz"]}
                        rules={[{ required: true, message: "频率必填" }]}
                      >
                        <InputNumber
                          style={{ width: 130 }}
                          step={0.0125}
                          placeholder="439.525"
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "mode"]}
                        rules={[{ required: true }]}
                      >
                        <Select style={{ width: 100 }} options={MODES} />
                      </Form.Item>
                      <Button
                        type="link"
                        danger
                        onClick={() => remove(field.name)}
                      >
                        删掉
                      </Button>
                    </Space>
                  ))}
                  <Button onClick={() => add({ mode: "FM" })}>加一条</Button>
                </>
              )}
            </Form.List>
          </Card>

          <Card size="small" title="BrandMeister 查询">
            <Typography.Paragraph type="secondary">
              每条规则单独一次查询，不要用 OR 合并，`amount`
              是合并去重后的全局上限，热闹的话务组会把安静的饿死。
              数值字段必须是数字，传字符串会静默返回空集。
            </Typography.Paragraph>
            <Form.List name="queries">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field) => (
                    <Space key={field.key} align="start" wrap>
                      <Form.Item
                        name={[field.name, "key"]}
                        rules={[{ required: true, message: "名字必填" }]}
                      >
                        <Input style={{ width: 150 }} placeholder="dst:46001" />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "rule", "id"]}
                        rules={[{ required: true }]}
                      >
                        <Select
                          style={{ width: 160 }}
                          options={[
                            {
                              value: "DestinationID",
                              label: "话务组 DestinationID",
                            },
                            { value: "SourceID", label: "发射方 SourceID" },
                          ]}
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "rule", "operator"]}
                        initialValue="equal"
                        hidden
                      >
                        <Input />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "rule", "value"]}
                        rules={[{ required: true, message: "必填" }]}
                      >
                        <InputNumber
                          style={{ width: 130 }}
                          placeholder="46001"
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "amount"]}
                        rules={[{ required: true }]}
                      >
                        <InputNumber
                          style={{ width: 110 }}
                          placeholder="200"
                          addonBefore="取"
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "intervalS"]}
                        rules={[{ required: true }]}
                      >
                        <InputNumber
                          style={{ width: 130 }}
                          placeholder="900"
                          addonAfter="秒"
                        />
                      </Form.Item>
                      <Button
                        type="link"
                        danger
                        onClick={() => remove(field.name)}
                      >
                        删掉
                      </Button>
                    </Space>
                  ))}
                  <Button
                    onClick={() =>
                      add({
                        rule: { id: "DestinationID", operator: "equal" },
                        amount: 200,
                        intervalS: 900,
                      })
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
      {/* 手机上表单很长，保存按钮放顶上的话填完要一路滚回去。 */}
      {!wide && settings !== undefined && (
        <div className="sticky-save">
          <Button
            type="primary"
            block
            size="large"
            loading={saving}
            onClick={() => form.submit()}
          >
            保存
          </Button>
        </div>
      )}
    </>
  );
}
