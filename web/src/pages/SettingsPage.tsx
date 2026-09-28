import { useCallback, useEffect, useState } from "react";
import {
  App,
  Button,
  Card,
  Form,
  Grid,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
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
 * 就不拦，否则只改本台信息也存不下去。开关关着时这一整卡不校验：字段还挂在
 * 表单上（隐藏但没卸载），但不该拦下和这一卡无关的保存。
 */
const checkChannels =
  (form: FormInstance<Settings>, enabled: boolean) =>
  async (_: unknown, rows?: ChannelRow[]) => {
    if (!enabled) return;
    // enabled 本身是开关，不算「这一卡填过东西」。
    const others = { ...(form.getFieldValue("analog") ?? {}), channels: [], enabled: undefined };
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
  // 配过模拟守听时缺省是开（配置里缺这个键也当开），拿到 false 才算关。
  // 没配过就缺省是关，人把开关打开了才展开这一卡。
  const analogEnabledField = Form.useWatch(["analog", "enabled"], form) as
    | boolean
    | undefined;
  const hasAnalog = settings?.analog !== undefined;
  const switchedOn = (v: boolean | undefined) =>
    hasAnalog ? v !== false : v === true;
  const analogOn = switchedOn(analogEnabledField);
  const bmEnabledField = Form.useWatch("brandmeisterEnabled", form) as
    | boolean
    | undefined;
  const bmOn = bmEnabledField !== false;

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

  const save = async () => {
    setSaving(true);
    try {
      // 关着的那张卡，body 里 Form.Item 藏着没卸载：getFieldsValue(true) 照样
      // 把它的值带上，原样存回去。onFinish 给的 values 只有校验过的字段，不够全。
      const values = form.getFieldsValue(true) as Settings;
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
          // 信道表和查询表整体的规则挂在 Form.List 上，改某一行时不会自己重跑。
          // 不补这一下，名字重复要点了保存才看得到；开关一变，也要让旧的校验
          // 结果跟着重算（关掉就该把「至少要有一个信道」这类错误收回去）。
          onValuesChange={(changed: Partial<Settings>) => {
            if (
              changed.analog?.channels !== undefined ||
              changed.analog?.enabled !== undefined
            ) {
              form
                .validateFields([["analog", "channels"]])
                .catch(() => undefined);
            }
            if (changed.queries !== undefined || changed.brandmeisterEnabled !== undefined) {
              form.validateFields([["queries"]]).catch(() => undefined);
            }
          }}
        >
          <Card
            size="small"
            style={{ marginBottom: 16 }}
            title={
              <Space>
                模拟守听
                <Form.Item
                  name={["analog", "enabled"]}
                  valuePropName="checked"
                  getValueProps={(v: boolean | undefined) => ({ checked: switchedOn(v) })}
                  noStyle
                >
                  <Switch
                    aria-label="模拟守听开关"
                    onChange={(checked) => {
                      // 关的时候把这一卡的字段收回上一次加载的样子，不是关掉了才顺手改的半成品。
                      // form.setFieldsValue 对嵌套对象是合并，没提到的键（比如 myUnitId）
                      // 不会被清掉，所以每一个叶子字段都要显式给一遍，没有就给 undefined。
                      if (!checked) {
                        const a = settings?.analog;
                        form.setFieldsValue({
                          analog: {
                            enabled: false,
                            channels: a?.channels ?? [],
                            gainDb: a?.gainDb,
                            myUnitId: a?.myUnitId,
                            openMarginDb: a?.openMarginDb,
                            closeMarginDb: a?.closeMarginDb,
                          },
                        });
                      }
                    }}
                  />
                </Form.Item>
              </Space>
            }
          >
            {!analogOn && (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                {hasAnalog
                  ? "关着。打开后才能改，原来的设置都留着。"
                  : "还没配模拟守听。打开开关填好信道，保存后就开始守听。"}
              </Typography.Paragraph>
            )}
            {/* 关着时这一段不卸载，只是不显示：校验和保存都不该丢掉已经填过的值。 */}
            <div style={{ display: analogOn ? undefined : "none" }}>
              <Typography.Paragraph type="secondary">
                要守的信道。频率只能是 2m（144–148）或 70cm（420–450），信道名进采集记录和发射行。
              </Typography.Paragraph>
              <Form.List
                name={["analog", "channels"]}
                rules={[{ validator: checkChannels(form, analogOn) }]}
              >
                {(fields, { add, remove }, { errors }) => (
                  <>
                    {fields.map((field) => (
                      <div key={field.key} className="list-row">
                        <Form.Item
                          name={[field.name, "freqMhz"]}
                          label="频率 MHz"
                          rules={analogOn ? [{ required: true, message: "频率必填" }] : []}
                        >
                          <InputNumber
                            style={{ width: "100%" }}
                            step={0.0125}
                            placeholder="438.500"
                            aria-label="信道频率 MHz"
                          />
                        </Form.Item>
                        <Form.Item
                          name={[field.name, "channel"]}
                          label="信道名"
                          rules={analogOn ? [{ required: true, message: "信道名必填" }] : []}
                        >
                          <Input placeholder="438.500 中继" aria-label="信道名" />
                        </Form.Item>
                        <Button
                          type="link"
                          danger
                          className="list-row-remove"
                          onClick={() => remove(field.name)}
                        >
                          删掉
                        </Button>
                      </div>
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
            </div>
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
                    <div key={field.key} className="list-row">
                      <Form.Item
                        name={[field.name, "name"]}
                        label="名字"
                        rules={[{ required: true, message: "名字必填" }]}
                      >
                        <Input placeholder="439.525 中继" />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "freqMhz"]}
                        label="频率 MHz"
                        rules={[{ required: true, message: "频率必填" }]}
                      >
                        <InputNumber
                          style={{ width: "100%" }}
                          step={0.0125}
                          placeholder="439.525"
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "mode"]}
                        label="模式"
                        rules={[{ required: true }]}
                      >
                        <Select options={MODES} />
                      </Form.Item>
                      <Button
                        type="link"
                        danger
                        className="list-row-remove"
                        onClick={() => remove(field.name)}
                      >
                        删掉
                      </Button>
                    </div>
                  ))}
                  <Button onClick={() => add({ mode: "FM" })}>加一条</Button>
                </>
              )}
            </Form.List>
          </Card>

          <Card
            size="small"
            title={
              <Space>
                BrandMeister 查询
                <Form.Item
                  name="brandmeisterEnabled"
                  valuePropName="checked"
                  getValueProps={(v: boolean | undefined) => ({ checked: v !== false })}
                  noStyle
                >
                  <Switch
                    aria-label="BrandMeister 开关"
                    onChange={(checked) => {
                      // 关的时候把查询表收回上一次加载的样子。
                      if (!checked) form.setFieldsValue({ queries: settings?.queries ?? [] });
                    }}
                  />
                </Form.Item>
              </Space>
            }
          >
            {!bmOn && (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                关着。打开后才能改，原来的设置都留着。
              </Typography.Paragraph>
            )}
            <div style={{ display: bmOn ? undefined : "none" }}>
              <Typography.Paragraph type="secondary">
                每条规则单独查一次，不要用 OR
                合并。「每次取」是合并去重之后的总上限，
                合在一起的话，热闹的话务组会把安静的挤掉。
              </Typography.Paragraph>
              <Form.List
                name="queries"
                rules={[
                  {
                    // 名字是轮询记录和运维页上认一条查询的唯一办法，重了就分不开。
                    validator: async (_, rows?: { key?: string }[]) => {
                      if (!bmOn) return;
                      const keys = (rows ?? []).map((r) => r?.key).filter(filled);
                      if (new Set(keys).size !== keys.length) {
                        throw new Error("查询名字不能重复");
                      }
                    },
                  },
                ]}
              >
                {(fields, { add, remove }, { errors }) => (
                  <>
                    {fields.map((field) => (
                      <div key={field.key} className="list-row">
                        <Form.Item
                          name={[field.name, "key"]}
                          label="名字"
                          rules={bmOn ? [{ required: true, message: "名字必填" }] : []}
                        >
                          <Input placeholder="dst:46001" />
                        </Form.Item>
                        <Form.Item
                          name={[field.name, "rule", "id"]}
                          label="查什么"
                          rules={bmOn ? [{ required: true }] : []}
                        >
                          <Select
                            popupMatchSelectWidth={false}
                            // 格子只有两列宽，带上英文字段名就放不下。英文名留在悬停提示里，
                            // 对 BrandMeister 的接口时还查得到。
                            options={[
                              {
                                value: "DestinationID",
                                label: "话务组",
                                title: "DestinationID",
                              },
                              {
                                value: "SourceID",
                                label: "发射方",
                                title: "SourceID",
                              },
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
                          label="号码"
                          rules={bmOn ? [{ required: true, message: "必填" }] : []}
                        >
                          <InputNumber
                            style={{ width: "100%" }}
                            placeholder="46001"
                          />
                        </Form.Item>
                        <Form.Item
                          name={[field.name, "amount"]}
                          label="每次取"
                          rules={bmOn ? [{ required: true }] : []}
                        >
                          <InputNumber
                            style={{ width: "100%" }}
                            placeholder="200"
                            suffix="行"
                          />
                        </Form.Item>
                        <Form.Item
                          name={[field.name, "intervalS"]}
                          label="间隔"
                          rules={bmOn ? [{ required: true }] : []}
                        >
                          <InputNumber
                            style={{ width: "100%" }}
                            placeholder="900"
                            suffix="秒"
                          />
                        </Form.Item>
                        <Button
                          type="link"
                          danger
                          className="list-row-remove"
                          onClick={() => remove(field.name)}
                        >
                          删掉
                        </Button>
                      </div>
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
                    <Form.ErrorList errors={errors} />
                  </>
                )}
              </Form.List>
            </div>
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
