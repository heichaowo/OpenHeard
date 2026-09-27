import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Button,
  Card,
  Grid,
  List,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import type { Origin } from "@core";
import { api, errorText } from "../api";
import type { HeardItem } from "../api";
import { AsyncContent } from "../components/AsyncContent";
import { PageHeader } from "../components/PageHeader";
import { useStore } from "../store";
import { useTime } from "../useTime";

const SOURCES: { value: Origin; label: string; empty: string }[] = [
  {
    value: "sdr-fm",
    label: "模拟",
    empty: "还没听到过模拟发射。接收机此刻的情况在运维页上。",
  },
  {
    value: "brandmeister",
    label: "数字",
    empty: "还没收到过 BrandMeister 的会话",
  },
];

const channelOf = (a: HeardItem) =>
  a.channel ?? (a.talkgroup === undefined ? "—" : `TG ${a.talkgroup}`);

/** myCall 是本台呼号。模拟侧的发射不带呼号，本台的那几次就用它，不说「呼号未知」。 */
function Sender({ a, myCall }: { a: HeardItem; myCall?: string }) {
  return (
    <Space size={4}>
      <Tag color={a.mine ? "blue" : "default"}>{a.mine ? "本台" : "对方"}</Tag>
      {a.callsign ??
        (a.mine ? myCall : undefined) ??
        (a.dmrId === undefined ? (
          <Typography.Text type="secondary">呼号未知</Typography.Text>
        ) : (
          <Typography.Text type="secondary">DMR {a.dmrId}</Typography.Text>
        ))}
    </Space>
  );
}

function Settled({ a }: { a: HeardItem }) {
  if (a.settled === "logged") return <Tag color="green">已入库</Tag>;
  if (a.settled === "ignored") return <Tag>已忽略</Tag>;
  return null;
}

/**
 * 收听记录。听到的每一次发射，不只是有本台的那几段。
 *
 * 只读。结算在待确认队列里做，这里只回答「到底听到了什么」。
 */
export default function HeardList() {
  const { recordings, station } = useStore();
  const time = useTime();
  const wide = Grid.useBreakpoint().md ?? true;
  const [origin, setOrigin] = useState<Origin>("sdr-fm");
  const [items, setItems] = useState<HeardItem[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // 切来源切得快时，先发的请求可能后回来。只认最新那一次的结果。
  const seq = useRef(0);

  const load = useCallback(async (o: Origin) => {
    const mine = ++seq.current;
    setLoading(true);
    // 往前翻的那次请求此刻作废了，它回来也不会再动这个标志。
    setMore(false);
    try {
      const page = await api.heard(o);
      if (mine !== seq.current) return;
      setItems(page.items);
      setNext(page.next);
      setError(undefined);
    } catch (e) {
      // 已经显示的列表留着，只多一条错误提示。清空的话一次失败就整页变成重试页。
      if (mine !== seq.current) return;
      setError(errorText(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 拉后端正是 effect 该做的事，setState 都在 await 之后。
    // oxlint-disable-next-line react/set-state-in-effect
    void load(origin);
  }, [origin, load]);

  const older = async () => {
    if (next === undefined) return;
    const mine = seq.current;
    setMore(true);
    try {
      const page = await api.heard(origin, next);
      if (mine !== seq.current) return;
      setItems((v) => [...v, ...page.items]);
      setNext(page.next);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(errorText(e));
    } finally {
      if (mine === seq.current) setMore(false);
    }
  };

  const audio = (a: HeardItem, style: CSSProperties) =>
    recordings.has(a.id) ? (
      <audio
        controls
        preload="none"
        src={`/api/recordings/${encodeURIComponent(a.id)}`}
        style={style}
      />
    ) : null;

  const cards = (
    <List
      dataSource={items}
      split={false}
      renderItem={(a) => (
        <List.Item style={{ padding: "0 0 12px" }}>
          <Card size="small" style={{ width: "100%" }}>
            <div className="pending-card-top">
              <Typography.Text type="secondary">
                {time.atShort(a.startAt)}
              </Typography.Text>
              <Typography.Text type="secondary">{channelOf(a)}</Typography.Text>
            </div>
            <Space size={8} wrap>
              <Sender a={a} myCall={station.myCallsign} />
              <Typography.Text type="secondary">
                {a.durationS.toFixed(1)} 秒
              </Typography.Text>
              <Settled a={a} />
            </Space>
            {audio(a, {
              display: "block",
              width: "100%",
              height: 32,
              marginTop: 10,
            })}
          </Card>
        </List.Item>
      )}
    />
  );

  const columns: TableColumnsType<HeardItem> = [
    {
      title: `时间 ${time.label}`,
      dataIndex: "startAt",
      render: time.at,
      width: 200,
    },
    { title: "信道", key: "channel", render: (_, a) => channelOf(a) },
    {
      title: "时长",
      dataIndex: "durationS",
      render: (s: number) => `${s.toFixed(1)} 秒`,
      width: 90,
    },
    {
      title: "发射方",
      key: "sender",
      render: (_, a) => <Sender a={a} myCall={station.myCallsign} />,
      width: 200,
    },
    // 模拟侧看音频信噪比，数字侧看误码率，都是判断信号好坏用的。
    {
      title: origin === "sdr-fm" ? "信噪比" : "误码率",
      key: "quality",
      width: 90,
      render: (_, a) =>
        origin === "sdr-fm"
          ? a.audioSnrDb === undefined
            ? "—"
            : `${a.audioSnrDb.toFixed(1)} dB`
          : a.ber === undefined
            ? "—"
            : `${a.ber}%`,
    },
    {
      title: "结算",
      key: "settled",
      render: (_, a) => <Settled a={a} />,
      width: 90,
    },
    {
      // 模拟 FM 空中不带身份信息，是谁只能听回去才知道。
      title: "录音",
      key: "audio",
      width: 260,
      render: (_, a) =>
        audio(a, { height: 32, maxWidth: 240 }) ?? (
          <Typography.Text type="secondary">没有</Typography.Text>
        ),
    },
  ];

  const source = SOURCES.find((s) => s.value === origin)!;

  return (
    <>
      <PageHeader
        title="收听记录"
        note="听到的每一次发射，不只是有本台的那几段。结算在待确认队列里做。"
        actions={
          <Button onClick={() => void load(origin)} loading={loading}>
            刷新
          </Button>
        }
      />
      <Card
        className="flush-card"
        title={
          <div className="card-toolbar">
            <Segmented<Origin>
              options={SOURCES.map(({ value, label }) => ({ value, label }))}
              value={origin}
              onChange={setOrigin}
            />
            <Typography.Text type="secondary">
              {items.length} 条{next === undefined ? "" : "，还有更早的"}
            </Typography.Text>
          </div>
        }
      >
        <AsyncContent
          loading={loading}
          error={error}
          empty={items.length === 0}
          emptyText={source.empty}
          onRetry={() => void load(origin)}
        >
          {wide ? (
            <Table
              rowKey="id"
              columns={columns}
              dataSource={items}
              pagination={false}
              scroll={{ x: 900 }}
            />
          ) : (
            cards
          )}
          {next !== undefined && (
            <div className="state-box">
              <Button onClick={older} loading={more}>
                更早的
              </Button>
            </div>
          )}
        </AsyncContent>
      </Card>
    </>
  );
}
