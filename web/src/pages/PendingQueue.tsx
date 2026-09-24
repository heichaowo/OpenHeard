import { useState } from "react";
import {
  App,
  Button,
  Checkbox,
  Collapse,
  Descriptions,
  Drawer,
  Form,
  List,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import { Card, Grid } from "antd";
import { AsyncContent } from "../components/AsyncContent";
import { PageHeader } from "../components/PageHeader";
import { QsoFields } from "../components/QsoFields";
import { FIELD_LABELS as LABELS } from "../fields";
import type { QsoFormValues } from "../components/QsoFields";
import { missingFields, normalizeCallsign } from "@core";
import { ApiError, errorText } from "../api";
import { confirmDiscard } from "../discard";
import type { Activity, ClusterPick, QsoDraft, QsoField } from "@core";
import { useRecall } from "../recall";
import { useStore } from "../store";
import type { PendingRow } from "../store";
import { draftFor } from "../subset";
import { useTime } from "../useTime";

const ORIGIN_LABELS: Record<Activity["origin"], string> = {
  brandmeister: "BrandMeister",
  "sdr-fm": "模拟接收机",
  "sdr-dmr": "数字接收机",
};

/** 聚类应当保证 activities 非空，但类型不保证，所以渲染不能假设。 */
const originOf = (row: PendingRow) => {
  const first = row.cluster.activities[0];
  return first ? ORIGIN_LABELS[first.origin] : "—";
};

/**
 * 一段里的逐次发射，手机上用。可以取消勾选。表格在这个宽度里塞不下，
 * 何况还有个播放器。
 *
 * 聚类按一个间隔阈值猜，会猜错。两段对话被并成一段时，把不属于这次通联的
 * 那几次取消掉，它们不会被结算，下一轮重新聚类自己会分出去。
 */
function ActivityList({
  activities,
  chosen,
  onToggle,
}: {
  activities: Activity[];
  chosen: string[];
  onToggle: (id: string) => void;
}) {
  const time = useTime();
  const { recordings } = useStore();
  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      {activities.map((a) => (
        <div key={a.id}>
          <Space size={8} wrap>
            <Checkbox
              checked={chosen.includes(a.id)}
              onChange={() => onToggle(a.id)}
            />
            <Typography.Text className="mono">
              {time.atShort(a.startAt)}
            </Typography.Text>
            <Typography.Text type="secondary">
              {a.durationS.toFixed(1)} 秒
            </Typography.Text>
            <Tag color={a.mine ? "blue" : "default"}>
              {a.mine ? "本台" : "对方"}
            </Tag>
            {a.callsign && (
              <Typography.Text strong>{a.callsign}</Typography.Text>
            )}
          </Space>
          {recordings.has(a.id) && (
            <audio
              controls
              preload="none"
              src={`/api/recordings/${encodeURIComponent(a.id)}`}
              style={{
                display: "block",
                width: "100%",
                height: 32,
                marginTop: 6,
              }}
            />
          )}
        </div>
      ))}
    </Space>
  );
}

function ActivityTable({ activities }: { activities: Activity[] }) {
  const time = useTime();
  const { recordings } = useStore();
  const columns: TableColumnsType<Activity> = [
    // 外层表头写了时区，这张展开表也要写，否则两个时间看着像不同口径。
    {
      title: `时间 ${time.label}`,
      dataIndex: "startAt",
      render: time.at,
      width: 220,
    },
    {
      title: "时长",
      dataIndex: "durationS",
      render: (s: number) => `${s.toFixed(1)} 秒`,
      width: 100,
    },
    {
      // 模拟 FM 空中不带身份信息，对方呼号只能靠回忆。能听回去才填得准。
      title: "录音",
      key: "audio",
      width: 260,
      render: (_, row) =>
        recordings.has(row.id) ? (
          <audio
            controls
            preload="none"
            src={`/api/recordings/${encodeURIComponent(row.id)}`}
            style={{ height: 32, maxWidth: 240 }}
          />
        ) : (
          <Typography.Text type="secondary">没有</Typography.Text>
        ),
    },
    {
      title: "发射方",
      dataIndex: "mine",
      render: (mine: boolean, row) => (
        <Space>
          <Tag color={mine ? "blue" : "default"}>{mine ? "本台" : "对方"}</Tag>
          {row.callsign ??
            (mine ? null : (
              <Typography.Text type="secondary">呼号未知</Typography.Text>
            ))}
        </Space>
      ),
      width: 200,
    },
    {
      title: "音频信噪比",
      dataIndex: "audioSnrDb",
      render: (v?: number) => (v === undefined ? "—" : `${v.toFixed(1)} dB`),
    },
    {
      title: "误码率",
      dataIndex: "ber",
      render: (v?: number) => (v === undefined ? "—" : `${v}%`),
    },
  ];
  return (
    <Table
      size="small"
      rowKey="id"
      columns={columns}
      dataSource={activities}
      pagination={false}
    />
  );
}

export default function PendingQueue() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<QsoFormValues>();
  const {
    pending,
    promote,
    ignore,
    ignoreMany,
    qsos,
    loading,
    error,
    refresh,
  } = useStore();
  const wide = Grid.useBreakpoint().md ?? true;
  // 打开抽屉那一刻的样子。15 秒一轮的刷新会让这一段长出新的发射，而段 id
  // 不变。确认时只结算打开时看到的那几次，后来的那几次没人看过。
  const [editing, setEditing] = useState<{
    row: PendingRow;
    ids: string[];
    draft: QsoDraft;
  } | null>(null);
  // 哪一行正在入库。楼下用手机弱网确认时，慢一点就会想再点一下。
  const [busyId, setBusyId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 段 id 到选中那一刻看到的那几次发射。道理同 editing：选完到确认之间
  // 对方回了一句，这句不能跟着「没人回」一起被忽略。
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const pickedCount = Object.keys(picked).length;
  const [clearing, setClearing] = useState(false);
  // 每一段里挑中了哪几次发射。没动过的段不在表里，就是整段。
  const [subset, setSubset] = useState<Record<string, string[]>>({});
  const {
    recalledAt,
    onValuesChange,
    reset: resetRecall,
  } = useRecall(form, qsos);
  const time = useTime();

  /**
   * 这一段里除了本台之外没有别人。
   *
   * 本台喊了一声没人应，这种段永远变不成通联，呼号不是「还没填」而是
   * 根本不存在。和「还缺对方呼号」分开说，人才知道不用去填它。
   */
  const aloneIn = (row: PendingRow) =>
    row.cluster.activities.every((a) => a.mine);

  /** 这一段现在算哪几次发射。没挑过就是全部。 */
  const chosen = (row: PendingRow) =>
    subset[row.cluster.id] ?? row.cluster.activities.map((a) => a.id);

  /** 挑过而且不是全部。只管界面上怎么说，往后端传的一律是 chosen。 */
  const narrowed = (row: PendingRow) =>
    chosen(row).length !== row.cluster.activities.length;

  const draftOf = (row: PendingRow) => draftFor(row, chosen(row));
  const missingOf = (row: PendingRow) => missingFields(draftOf(row));

  const ignoreTitle = (row: PendingRow) =>
    narrowed(row)
      ? `只忽略挑中的 ${chosen(row).length} 次发射？`
      : "不记这次对话？";

  const toggleActivity = (row: PendingRow, id: string) =>
    setSubset((m) => {
      const now = m[row.cluster.id] ?? row.cluster.activities.map((a) => a.id);
      const next = now.includes(id)
        ? now.filter((x) => x !== id)
        : [...now, id];
      return { ...m, [row.cluster.id]: next };
    });

  const open = (row: PendingRow) => {
    const ids = chosen(row);
    const draft = draftFor(row, ids);
    setEditing({ row, ids, draft });
    resetRecall();
    form.setFieldsValue({
      call: draft.call ?? "",
      rstSent: draft.rstSent,
      rstRcvd: draft.rstRcvd,
      gridsquare: undefined,
      qth: undefined,
      myQth: draft.myQth,
      myDevice: draft.myDevice,
      myAntenna: draft.myAntenna,
      myPower: draft.myPower,
      myHeightM: draft.myHeightM,
      note: undefined,
    });
  };

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.missing?.length) {
      message.error(
        `还缺 ${e.missing.map((k) => LABELS[k as QsoField] ?? k).join("、")}`,
      );
    } else {
      message.error(errorText(e));
    }
  };

  // 数字侧一大半是一两秒的空按，永远不会变成通联。一条一条点忽略太熬人。
  const sweep = async () => {
    if (pickedCount === 0) return;
    setClearing(true);
    try {
      const picks: ClusterPick[] = Object.entries(picked).map(
        ([clusterId, activityIds]) => ({ clusterId, activityIds }),
      );
      const r = await ignoreMany(picks);
      setPicked({});
      message.success(
        `忽略了 ${r.ignored} 段` +
          (r.missing.length > 0 ? `，${r.missing.length} 段已经变了` : ""),
      );
    } catch (e) {
      fail(e);
    } finally {
      setClearing(false);
    }
  };

  const snapshot = (rows: PendingRow[]) =>
    Object.fromEntries(rows.map((r) => [r.cluster.id, chosen(r)]));

  const toggle = (row: PendingRow) =>
    setPicked((m) => {
      const { [row.cluster.id]: was, ...rest } = m;
      return was === undefined ? { ...m, ...snapshot([row]) } : rest;
    });

  const pickShort = () =>
    setPicked(
      snapshot(
        pending.filter(
          (r) =>
            r.cluster.activities.length === 1 &&
            r.cluster.endAt - r.cluster.startAt < 3,
        ),
      ),
    );

  const pickAlone = () => setPicked(snapshot(pending.filter(aloneIn)));

  const toolbar = pending.length > 0 && (
    <div className="sweep-bar">
      <Button size="small" onClick={pickShort}>
        选中只按了一下的
      </Button>
      <Button
        size="small"
        onClick={pickAlone}
        disabled={!pending.some(aloneIn)}
      >
        选中没人回的（{pending.filter(aloneIn).length}）
      </Button>
      <Button
        size="small"
        onClick={() => setPicked({})}
        disabled={pickedCount === 0}
      >
        取消选中
      </Button>
      <Popconfirm
        title={`忽略选中的 ${pickedCount} 段？`}
        onConfirm={sweep}
        disabled={pickedCount === 0}
      >
        <Button
          size="small"
          danger
          loading={clearing}
          disabled={pickedCount === 0}
        >
          忽略选中（{pickedCount}）
        </Button>
      </Popconfirm>
    </div>
  );

  const straightIn = async (row: PendingRow) => {
    const draft = draftOf(row);
    setBusyId(row.cluster.id);
    try {
      await promote(row.cluster.id, draft, chosen(row));
      message.success(`${draft.call} 已入库`);
    } catch (e) {
      fail(e);
    } finally {
      setBusyId(null);
    }
  };

  const close = () => confirmDiscard(modal, form, "填", () => setEditing(null));

  const submit = async (values: QsoFormValues) => {
    if (!editing) return;
    const draft: QsoDraft = {
      ...editing.draft,
      ...values,
      call: normalizeCallsign(values.call),
    };
    const still = missingFields(draft);
    if (still.length > 0) {
      message.error(`还缺 ${still.map((k) => LABELS[k] ?? k).join("、")}`);
      return;
    }
    setSubmitting(true);
    try {
      await promote(editing.row.cluster.id, draft, editing.ids);
      setEditing(null);
      message.success(`${draft.call} 已入库`);
    } catch (e) {
      fail(e);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * 手机上的一段一张卡。
   *
   * 表格在 375 像素宽里要横滚 900 像素，屏幕上只剩时间和信道，而确认、忽略
   * 和呼号全在看不见的右边。这一页存在的意义就是那几个按钮，站在楼下拿手机
   * 时更是只有这几个按钮要紧。
   */
  const cards = (
    <List
      dataSource={pending}
      split={false}
      renderItem={(row) => {
        const draft = draftOf(row);
        const missing = missingOf(row);
        const ready = missing.length === 0;
        const busy = busyId === row.cluster.id;
        const none = chosen(row).length === 0;
        return (
          <List.Item style={{ padding: "0 0 12px" }}>
            <Card size="small" style={{ width: "100%" }}>
              <div className="pending-card-top">
                <Space size={8}>
                  <Checkbox
                    checked={picked[row.cluster.id] !== undefined}
                    onChange={() => toggle(row)}
                  />
                  <Typography.Text type="secondary">
                    {time.atShort(row.cluster.startAt)}
                  </Typography.Text>
                </Space>
                <Space size={4}>
                  <Tag>{row.draft.mode}</Tag>
                  <Typography.Text type="secondary" ellipsis>
                    {row.cluster.activities[0]?.channel ?? originOf(row)}
                  </Typography.Text>
                </Space>
              </div>

              <div className="pending-card-call">
                {draft.call ??
                  (aloneIn(row) ? (
                    <Tag>只有本台，没人回</Tag>
                  ) : (
                    <Tag color="orange">对方呼号待补</Tag>
                  ))}
              </div>

              <Space size={4} wrap style={{ marginBottom: 12 }}>
                {ready ? (
                  <Tag color="green">可直接入库</Tag>
                ) : (
                  missing.map((k) => (
                    <Tag key={k} color="orange">
                      还缺{LABELS[k] ?? k}
                    </Tag>
                  ))
                )}
                <Typography.Text type="secondary">
                  {row.cluster.activities.length} 次 /{" "}
                  {Math.round(row.cluster.endAt - row.cluster.startAt)} 秒
                </Typography.Text>
              </Space>

              <div className="pending-card-actions">
                <Button
                  type="primary"
                  block
                  disabled={none}
                  onClick={() => open(row)}
                >
                  {ready ? "编辑" : "确认"}
                </Button>
                {/* 位置固定。这一格 15 秒刷一次，按钮随数据出现或消失的话，
                    手指落下去的那一刻底下已经换成另一个了。 */}
                <Button
                  block
                  loading={busy}
                  disabled={!ready || none || (busyId !== null && !busy)}
                  onClick={() => straightIn(row)}
                >
                  直接入库
                </Button>
                <Popconfirm
                  title={ignoreTitle(row)}
                  disabled={none}
                  onConfirm={() =>
                    ignore(row.cluster.id, chosen(row)).catch(fail)
                  }
                >
                  <Button block danger disabled={none}>
                    忽略
                  </Button>
                </Popconfirm>
              </div>

              <Collapse
                ghost
                size="small"
                items={[
                  {
                    key: "acts",
                    label: !narrowed(row)
                      ? `逐次发射（${row.cluster.activities.length}）`
                      : none
                        ? "逐次发射（一次都没挑，挑几次才能确认或忽略）"
                        : `逐次发射（挑中 ${chosen(row).length} / ${row.cluster.activities.length}）`,
                    children: (
                      <ActivityList
                        activities={row.cluster.activities}
                        chosen={chosen(row)}
                        onToggle={(id) => toggleActivity(row, id)}
                      />
                    ),
                  },
                ]}
              />
            </Card>
          </List.Item>
        );
      }}
    />
  );

  const columns: TableColumnsType<PendingRow> = [
    {
      title: `时间 ${time.label}`,
      key: "startAt",
      render: (_, row) => time.at(row.cluster.startAt),
      width: 200,
    },
    {
      title: "信道",
      key: "channel",
      render: (_, row) => row.cluster.activities[0]?.channel ?? originOf(row),
    },
    {
      title: "模式",
      key: "mode",
      render: (_, row) => <Tag>{row.draft.mode}</Tag>,
      width: 90,
    },
    {
      title: "发射",
      key: "activities",
      render: (_, row) =>
        `${row.cluster.activities.length} 次 / ${Math.round(row.cluster.endAt - row.cluster.startAt)} 秒`,
      width: 140,
    },
    {
      title: "对方呼号",
      key: "call",
      render: (_, row) =>
        draftOf(row).call ??
        (aloneIn(row) ? <Tag>没人回</Tag> : <Tag color="orange">待补</Tag>),
      width: 120,
    },
    {
      title: "还缺",
      key: "missing",
      render: (_, row) =>
        missingOf(row).length === 0 ? (
          <Tag color="green">可直接入库</Tag>
        ) : (
          <Space size={4}>
            {missingOf(row).map((k) => (
              <Tag key={k} color="orange">
                {LABELS[k] ?? k}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: "操作",
      key: "action",
      width: 220,
      fixed: wide ? ("right" as const) : undefined,
      render: (_, row) => (
        <Space size={0}>
          <Button
            type="link"
            loading={busyId === row.cluster.id}
            disabled={
              missingOf(row).length > 0 ||
              (busyId !== null && busyId !== row.cluster.id)
            }
            onClick={() => straightIn(row)}
          >
            直接入库
          </Button>
          <Button type="link" onClick={() => open(row)}>
            {missingOf(row).length === 0 ? "编辑" : "确认"}
          </Button>
          <Popconfirm
            title={ignoreTitle(row)}
            onConfirm={() => ignore(row.cluster.id, chosen(row)).catch(fail)}
          >
            <Button type="link" danger>
              忽略
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="待确认队列"
        note="机器能填的已经填好。模拟信号不带身份信息，所以对方呼号只能人补。"
      />
      <Card className="flush-card">
        <AsyncContent
          loading={loading}
          error={error}
          empty={pending.length === 0}
          emptyText="队列空了，没有等着确认的对话"
          onRetry={refresh}
        >
          {toolbar}
          {wide ? (
            <Table
              rowKey={(row) => row.cluster.id}
              rowSelection={{
                selectedRowKeys: Object.keys(picked),
                // 已经选中的留着当初那份，新选中的现拍一份。
                onChange: (keys) =>
                  setPicked((m) =>
                    Object.fromEntries(
                      pending
                        .filter((r) => keys.includes(r.cluster.id))
                        .map((r) => [
                          r.cluster.id,
                          m[r.cluster.id] ?? chosen(r),
                        ]),
                    ),
                  ),
              }}
              columns={columns}
              dataSource={pending}
              pagination={false}
              scroll={{ x: 900 }}
              expandable={{
                expandedRowRender: (row) => (
                  <ActivityTable activities={row.cluster.activities} />
                ),
              }}
            />
          ) : (
            cards
          )}
        </AsyncContent>
      </Card>
      <Drawer
        title="确认入库"
        // 手机上 420 比屏幕还宽，antd 不会自己收，于是抽屉开着整页要横滚。
        width={wide ? 420 : "100%"}
        open={editing !== null}
        maskClosable={false}
        onClose={close}
        extra={
          <Button
            type="primary"
            loading={submitting}
            onClick={() => form.submit()}
          >
            入库
          </Button>
        }
      >
        {editing && (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={`时间 ${time.label}`}>
                {time.at(editing.draft.startAt ?? editing.row.cluster.startAt)}
              </Descriptions.Item>
              <Descriptions.Item label="频率">
                {editing.draft.freqMhz} MHz
              </Descriptions.Item>
              <Descriptions.Item label="波段">
                {editing.draft.band}
              </Descriptions.Item>
              <Descriptions.Item label="模式">
                {editing.draft.mode}
              </Descriptions.Item>
              <Descriptions.Item label="来源">
                {originOf(editing.row)}
              </Descriptions.Item>
            </Descriptions>
            <Form
              form={form}
              layout="vertical"
              onFinish={submit}
              onValuesChange={onValuesChange}
              style={{ marginTop: 24 }}
            >
              <QsoFields
                recalledFrom={
                  recalledAt === undefined ? undefined : time.at(recalledAt)
                }
              />
              {/* 让输入框里按回车也能提交，抽屉标题栏那个按钮在表单外面 */}
              <Button htmlType="submit" style={{ display: "none" }} />
            </Form>
          </>
        )}
      </Drawer>
    </>
  );
}
