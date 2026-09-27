import { useMemo, useState } from "react";
import {
  App,
  Button,
  Card,
  List,
  Descriptions,
  Drawer,
  Form,
  Grid,
  Input,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { api, errorText } from "../api";
import type { QsoChange } from "../api";
import { confirmDiscard } from "../discard";
import { AsyncContent } from "../components/AsyncContent";
import { PageHeader } from "../components/PageHeader";
import { QsoFields } from "../components/QsoFields";
import { FIELD_LABELS } from "../fields";
import type { QsoFormValues } from "../components/QsoFields";
import type { TableColumnsType } from "antd";
import { adifFile, missingFields, normalizeCallsign } from "@core";
import type { Qso, QsoDraft } from "@core";
import { useRecall } from "../recall";
import { useStore } from "../store";
import { useTime } from "../useTime";

function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function LogList() {
  const { message, modal } = App.useApp();
  const { qsos, editQso, removeQso, importAdif, loading, error, refresh } =
    useStore();
  const wide = Grid.useBreakpoint().md ?? true;
  const [search, setSearch] = useState("");
  const [form] = Form.useForm<QsoFormValues>();
  const [editing, setEditing] = useState<Qso | null>(null);
  const [saving, setSaving] = useState(false);
  const {
    recalledAt,
    onValuesChange,
    reset: resetRecall,
  } = useRecall(form, qsos);
  const [changes, setChanges] = useState<Record<string, QsoChange[]>>({});
  const loadChanges = (id: string) =>
    api
      .qsoHistory(id)
      .then((h) => setChanges((m) => ({ ...m, [id]: h })))
      .catch(() => setChanges((m) => ({ ...m, [id]: [] })));
  const [importing, setImporting] = useState(false);
  const time = useTime();

  // 呼号按呼号的写法比，QTH、网格和备注按原文不分大小写找。
  // 只能搜呼号的话，「上次在克拉玛依碰到的那个人」就找不回来。
  const rows = useMemo(() => {
    const call = normalizeCallsign(search);
    const text = search.trim().toLowerCase();
    const matched = text
      ? qsos.filter(
          (q) =>
            (call !== "" && q.call.includes(call)) ||
            [q.qth, q.gridsquare, q.note].some((v) =>
              v?.toLowerCase().includes(text),
            ),
        )
      : qsos;
    return [...matched].sort((a, b) => b.startAt - a.startAt);
  }, [qsos, search]);

  // 改一条而不是删了重录。手工补录会丢掉 id 和创建时间，自动来的那些还会
  // 一并丢掉和当初那几次发射的联系。
  const open = (q: Qso) => {
    setEditing(q);
    resetRecall();
    form.setFieldsValue({
      call: q.call,
      rstSent: q.rstSent,
      rstRcvd: q.rstRcvd,
      gridsquare: q.gridsquare,
      qth: q.qth,
      myGridsquare: q.myGridsquare,
      myQth: q.myQth,
      myDevice: q.myDevice,
      myAntenna: q.myAntenna,
      myPower: q.myPower,
      myHeightM: q.myHeightM,
      note: q.note,
    });
  };

  const close = () => confirmDiscard(modal, form, "改", () => setEditing(null));

  const save = async (values: QsoFormValues) => {
    if (!editing) return;
    const draft: QsoDraft = {
      ...editing,
      ...values,
      call: normalizeCallsign(values.call),
    };
    const still = missingFields(draft);
    if (still.length > 0) {
      message.error(
        `还缺 ${still.map((k) => FIELD_LABELS[k] ?? k).join("、")}`,
      );
      return;
    }
    setSaving(true);
    try {
      await editQso(editing.id, draft);
      // 拉过改动记录的那一行要重拉，否则展开还是改之前的次数和内容。
      if (changes[editing.id] !== undefined) void loadChanges(editing.id);
      setEditing(null);
      message.success(`${draft.call} 已更新`);
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 从 .adi 文件导入。
   *
   * 判重在服务端做（呼号加分钟），所以同一份文件导两遍不会多出记录。
   * 读不了的那几条会单独报出来，好的照样进。
   */
  const pickFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".adi,.adif,text/plain";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImporting(true);
      try {
        const r = await importAdif(await file.text());
        const parts = [`读到 ${r.parsed} 条`, `进了 ${r.imported} 条`];
        if (r.skipped > 0) parts.push(`${r.skipped} 条已经有了`);
        if (r.problems.length > 0) parts.push(`${r.problems.length} 条读不了`);
        if (r.problems.length > 0) {
          modal.info({
            title: parts.join("，"),
            content: (
              <Space direction="vertical" size={4}>
                {r.problems.slice(0, 20).map((p) => (
                  <Typography.Text key={p} type="secondary">
                    {p}
                  </Typography.Text>
                ))}
                {r.problems.length > 20 && (
                  <Typography.Text type="secondary">
                    还有 {r.problems.length - 20} 条
                  </Typography.Text>
                )}
              </Space>
            ),
          });
        } else {
          message.success(parts.join("，"));
        }
      } catch (e) {
        message.error(errorText(e));
      } finally {
        setImporting(false);
      }
    };
    input.click();
  };

  const exportAdif = () => {
    if (rows.length === 0) {
      message.warning("没有可导出的记录");
      return;
    }
    download("openheard.adi", adifFile(rows));
    message.success(
      search.trim()
        ? `导出筛选出的 ${rows.length} 条，不是全部`
        : `导出 ${rows.length} 条`,
    );
  };

  /** 自动入库的那条删掉之后，它用到的发射会回到待确认队列，要先说清楚。 */
  const deleteTitle = (q: Qso) =>
    q.clusterId
      ? `删除与 ${q.call} 的通联？它用到的那几次发射会回到待确认队列。`
      : `删除与 ${q.call} 的通联？`;

  /** 手机上的一条一张卡。和待确认队列同一个道理：表格在这个宽度里要横滚。 */
  const cards = (
    <List
      dataSource={rows}
      split={false}
      renderItem={(q) => (
        <List.Item style={{ padding: "0 0 12px" }}>
          <Card size="small" style={{ width: "100%" }}>
            <div className="pending-card-top">
              <Typography.Text type="secondary">
                {time.atShort(q.startAt)}
              </Typography.Text>
              <Space size={4}>
                <Tag>{q.mode}</Tag>
                {q.clusterId ? <Tag color="blue">自动</Tag> : <Tag>手工</Tag>}
              </Space>
            </div>
            <div className="pending-card-call">{q.call}</div>
            <Space size={4} wrap style={{ marginBottom: 12 }}>
              <Typography.Text type="secondary">
                {q.freqMhz} MHz · {q.band} · 报告 {q.rstSent}/{q.rstRcvd}
              </Typography.Text>
              {[q.qth, q.gridsquare].filter(Boolean).length > 0 && (
                <Typography.Text type="secondary">
                  {[q.qth, q.gridsquare].filter(Boolean).join(" ")}
                </Typography.Text>
              )}
            </Space>
            {q.note && (
              <Typography.Paragraph style={{ marginBottom: 12 }}>
                {q.note}
              </Typography.Paragraph>
            )}
            <div className="pending-card-actions">
              <Button type="primary" block onClick={() => open(q)}>
                编辑
              </Button>
              <Popconfirm
                title={deleteTitle(q)}
                onConfirm={() =>
                  removeQso(q.id).catch((e: Error) => message.error(e.message))
                }
              >
                <Button block danger>
                  删除
                </Button>
              </Popconfirm>
            </div>
          </Card>
        </List.Item>
      )}
    />
  );

  const columns: TableColumnsType<Qso> = [
    {
      title: `时间 ${time.label}`,
      dataIndex: "startAt",
      render: time.at,
      width: 184,
    },
    {
      title: "呼号",
      dataIndex: "call",
      width: 148,
      ellipsis: true,
      render: (call: string) => (
        <Typography.Text strong title={call}>
          {call}
        </Typography.Text>
      ),
    },
    {
      title: "频率",
      dataIndex: "freqMhz",
      width: 128,
      render: (f: number) => `${f} MHz`,
    },
    // 波段看频率就知道。窄一点的屏幕上把位置让给 QTH。
    { title: "波段", dataIndex: "band", width: 72, responsive: ["xxl"] },
    {
      title: "模式",
      dataIndex: "mode",
      width: 80,
      render: (m: string) => <Tag>{m}</Tag>,
    },
    {
      title: "报告 发/收",
      key: "rst",
      width: 100,
      render: (_, q) => `${q.rstSent} / ${q.rstRcvd}`,
    },
    {
      title: "来源",
      key: "source",
      width: 80,
      render: (_, q) =>
        q.clusterId ? <Tag color="blue">自动</Tag> : <Tag>手工</Tag>,
    },
    {
      // 不定宽，余下的宽度都给它。再长就省略，悬停看全文。
      title: "对方 QTH",
      key: "their",
      ellipsis: true,
      render: (_, q) => [q.qth, q.gridsquare].filter(Boolean).join(" ") || "—",
    },
    {
      title: "操作",
      key: "action",
      width: 140,
      fixed: wide ? ("right" as const) : undefined,
      render: (_, q) => (
        <Space size={0} className="compact-links">
          <Button type="link" onClick={() => open(q)}>
            编辑
          </Button>
          <Popconfirm
            title={deleteTitle(q)}
            onConfirm={() =>
              removeQso(q.id).catch((e: Error) => message.error(e.message))
            }
          >
            <Button type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="日志"
        note="正式记录。每一行都由人的判断产生，导出的 ADIF 以它为准。"
        actions={
          <Space>
            <Button loading={importing} onClick={pickFile}>
              导入 ADIF
            </Button>
            {/* 搜索框里有字时导出的只是筛出来的那几条，按钮上要说出来。
                拿去传 LoTW 的人会以为是整本日志。 */}
            <Button onClick={exportAdif}>
              {search.trim() ? `导出筛选出的 ${rows.length} 条` : "导出 ADIF"}
            </Button>
          </Space>
        }
      />
      <Card
        className="flush-card"
        title={
          <div className="card-toolbar">
            <Input.Search
              allowClear
              className="card-toolbar-search"
              placeholder="按呼号、QTH、网格或备注筛选"
              onChange={(e) => setSearch(e.target.value)}
            />
            <Typography.Text type="secondary">{rows.length} 条</Typography.Text>
          </div>
        }
      >
        <AsyncContent
          loading={loading}
          error={error}
          empty={rows.length === 0}
          emptyText={search ? "没有匹配的呼号" : "还没有通联"}
          onRetry={refresh}
        >
          {wide ? (
            <Table
              rowKey="id"
              columns={columns}
              dataSource={rows}
              // 各列定宽加起来约 950，QTH 至少留 200。
              scroll={{ x: 1150 }}
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
              expandable={{
                // 改动历史要展开才知道有没有，所以每行都可展开。
                onExpand: (open, q) => {
                  if (!open || changes[q.id] !== undefined) return;
                  void loadChanges(q.id);
                },
                expandedRowRender: (q) => (
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">
                      本台{" "}
                      {[
                        q.myQth,
                        q.myGridsquare,
                        q.myDevice,
                        q.myAntenna,
                        q.myPower,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      {q.myHeightM === undefined
                        ? ""
                        : ` · 天线 ${q.myHeightM} m`}
                    </Typography.Text>
                    {q.note && <Typography.Text>{q.note}</Typography.Text>}
                    {/* 还没读回来时要说一声，否则和「从没改过」看起来一样。
                        每一次都列出来，不只是最近那次：错改之后又改，最早那一版才是原样。 */}
                    {changes[q.id] === undefined ? (
                      <Typography.Text type="secondary">
                        正在读改动记录
                      </Typography.Text>
                    ) : changes[q.id].length > 0 ? (
                      <>
                        <Typography.Text type="secondary">
                          改过 {changes[q.id].length} 次，最近的在前：
                        </Typography.Text>
                        {changes[q.id].map((c) => (
                          <Typography.Text type="secondary" key={c.at}>
                            {time.at(c.at)} 之前是「
                            {[
                              c.before.call,
                              `${c.before.rstSent}/${c.before.rstRcvd}`,
                              c.before.qth,
                              c.before.note,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                            」
                          </Typography.Text>
                        ))}
                      </>
                    ) : null}
                  </Space>
                ),
              }}
            />
          ) : (
            cards
          )}
        </AsyncContent>
      </Card>
      <Drawer
        title="改一条通联"
        width={wide ? 420 : "100%"}
        open={editing !== null}
        maskClosable={false}
        onClose={close}
        extra={
          <Button type="primary" loading={saving} onClick={() => form.submit()}>
            保存
          </Button>
        }
      >
        {editing && (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={`时间 ${time.label}`}>
                {time.at(editing.startAt)}
              </Descriptions.Item>
              <Descriptions.Item label="频率">
                {editing.freqMhz} MHz
              </Descriptions.Item>
              <Descriptions.Item label="波段">{editing.band}</Descriptions.Item>
              <Descriptions.Item label="模式">{editing.mode}</Descriptions.Item>
              <Descriptions.Item label="来源">
                {editing.clusterId ? "自动" : "手工"}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Paragraph
              type="secondary"
              style={{ marginTop: 12, marginBottom: 0 }}
            >
              时间、频率、波段和模式改不了。要改它们就删掉重录。
            </Typography.Paragraph>
            <Form
              form={form}
              layout="vertical"
              onFinish={save}
              onValuesChange={onValuesChange}
              style={{ marginTop: 16 }}
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
