import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Grid,
  List,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import { api, errorText } from "../api";
import type { Ops, PollRow } from "../api";
import { AsyncContent } from "../components/AsyncContent";
import { PageHeader } from "../components/PageHeader";
import { useStore } from "../store";
import { useTime } from "../useTime";

/** 运维数据自己拉，不进全局 store：只有这一页要，刷新频率也不一样。 */
const POLL_MS = 20000;

const ORIGINS: Record<string, string> = {
  brandmeister: "BrandMeister",
  "sdr-fm": "模拟接收机",
  "sdr-dmr": "数字接收机",
};

const bytes = (n?: number) =>
  n === undefined ? "—" : `${(n / 1e9).toFixed(1)} GB`;

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

const duration = (s: number) => {
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} 小时`;
  return `${(s / 86400).toFixed(1)} 天`;
};

/** 标签列不折行。手机上「本进程内存」被挤成三行，一眼看不出是哪一项。 */
const LABEL_NOWRAP = { label: { whiteSpace: "nowrap" as const } };

/** 现在的噪声离「开」还差多少 dB。负数说明已经过线了。 */
const margin = (r: { noiseDb?: number; openBelowDb?: number }) =>
  r.noiseDb === undefined || r.openBelowDb === undefined
    ? undefined
    : r.noiseDb - r.openBelowDb;

/** 多久以前。一分钟以内写秒，再往上写分钟、小时、天，不让人自己除 60。 */
const ago = (now: number, at?: number) => {
  if (at === undefined) return "还没有";
  const s = Math.max(0, now - at);
  return s < 60 ? `${s} 秒前` : `${duration(s)}前`;
};

export default function OpsPage() {
  const [ops, setOps] = useState<Ops | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  // 只管刷新按钮转不转。loading 只在第一次拉取时为真，定时拉取不该闪骨架屏。
  const [refreshing, setRefreshing] = useState(false);
  // 上一次还没回来就别再发。重试按钮和 20 秒的定时器用的是同一个 load，
  // 两个请求抢着 setOps，后回来的那个未必是后发的那个。
  const inFlight = useRef(false);
  const time = useTime();
  const wide = Grid.useBreakpoint().md ?? true;
  // 今天、最近 7 天记了几条通联：按界面选的时区划，所以在前端算，
  // 通联本身走全局 store，不额外拉一次。
  const { qsos } = useStore();
  const [todayCount, last7Count] = useMemo(() => {
    const todayStart = time.dayStart(0);
    const last7Start = time.dayStart(6);
    return [
      qsos.filter((q) => q.startAt >= todayStart).length,
      qsos.filter((q) => q.startAt >= last7Start).length,
    ];
  }, [qsos, time]);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setOps(await api.ops());
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // setState 都在 await 之后，规则认不出异步这一层。拉后端正是 effect 该做的事。
    // oxlint-disable-next-line react/set-state-in-effect
    void load();
    // 标签页在后台时不拉。这一页是留着看的，没人看的时候拉只是白占带宽和数据库。
    const tick = () => {
      if (!document.hidden) void load();
    };
    const t = setInterval(tick, POLL_MS);
    // 切回来立刻补一次，否则要等下一个 20 秒才知道现在是什么样。
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  const columns: TableColumnsType<PollRow> = [
    {
      title: `时间 ${time.label}`,
      dataIndex: "at",
      render: time.at,
      width: 190,
    },
    {
      title: "来源",
      dataIndex: "queryKey",
      width: 180,
      render: (k: string) => <span className="mono">{k}</span>,
    },
    {
      title: "取回 / 解析 / 写入",
      key: "counts",
      width: 170,
      render: (_, r) => (
        <span className="mono">
          {r.fetched} / {r.parsed} / {r.written}
        </span>
      ),
    },
    {
      title: "耗时",
      dataIndex: "ms",
      width: 90,
      render: (n: number) => `${n} ms`,
    },
    {
      title: "结果",
      key: "ok",
      render: (_, r) =>
        r.ok ? (
          <Tag color="green">正常</Tag>
        ) : (
          <>
            <Tag color="red">失败</Tag>
            <span className="mono">{r.errorMsg}</span>
          </>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="运维"
        note="无人值守时这几个数字是唯一能读到的东西。取回多少行、解析出多少行、写入多少行分开记，来源改字段时才看得出来。"
        actions={
          <Button
            loading={refreshing}
            onClick={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          >
            刷新
          </Button>
        }
      />
      <AsyncContent
        loading={loading}
        error={error}
        empty={ops === undefined}
        emptyText="拿不到运维数据"
        onRetry={load}
      >
        {ops && (
          <>
            {ops.health.ok ? (
              <Alert
                type="success"
                showIcon
                style={{ marginBottom: 16 }}
                message={`一切正常，最近一次采集在 ${ago(ops.now, ops.health.lastPollAt)}`}
              />
            ) : (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                message="有问题"
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                    {ops.health.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                }
              />
            )}

            {/* 列数交给 CSS，写成行内样式的话媒体查询永远赢不了它。 */}
            <div className="stat-row stat-row-2">
              <Card size="small">
                <Statistic
                  title={`今天 ${time.label}`}
                  value={todayCount}
                  suffix="条"
                />
              </Card>
              <Card size="small">
                <Statistic
                  title={`最近 7 天 ${time.label}`}
                  value={last7Count}
                  suffix="条"
                />
              </Card>
            </div>

            <div className="stat-row stat-row-4">
              <Card size="small">
                <Statistic
                  title="采集到的发射"
                  value={ops.health.activityCount}
                />
              </Card>
              <Card size="small">
                <Statistic title="正式通联" value={ops.health.qsoCount} />
              </Card>
              <Card size="small">
                <Statistic
                  title="最近一次采集"
                  value={ago(ops.now, ops.health.lastPollAt)}
                  styles={{ content: { fontSize: 20 } }}
                />
              </Card>
              <Card size="small">
                <Statistic
                  title="磁盘剩余"
                  value={bytes(ops.health.freeBytes)}
                  styles={{ content: { fontSize: 20 } }}
                />
              </Card>
            </div>

            {/* 关着的那一路不算健康问题，这里直接说明，不摆电台或轮询的告警。 */}
            <Card size="small" title="电台" style={{ marginBottom: 16 }}>
              {!ops.analogEnabled ? (
                <Alert
                  type="info"
                  showIcon
                  message="模拟守听关着。设置页打开开关、存了设置，才会重新开始收。"
                />
              ) : ops.radios.length === 0 ? (
                <Alert
                  type="info"
                  showIcon
                  message="没有模拟守听，或者守护进程还没报上来。配了 analog 的话，等几秒再看。"
                />
              ) : (
                <>
                  {/* 几个信道由同一支接收机收，新鲜与否、最后一句话和重开次数是它的，不是哪个信道的。 */}
                  {!ops.radios[0]!.fresh && (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={`已经 ${ops.radios[0]!.ageS} 秒没有电台状态了，接收机可能掉了`}
                      description={ops.radios[0]!.lastError}
                    />
                  )}
                  <Typography.Paragraph type="secondary">
                    一支接收机，增益 {ops.radios[0]!.gainDb} dB，守{" "}
                    {ops.radios.length} 个信道。有载波时噪声会塌下去，所以是低于门限才算开。
                    {ops.radios[0]!.lastError !== undefined && (
                      <>
                        {" "}
                        rtl_sdr 最后一句：
                        <span className="mono">{ops.radios[0]!.lastError}</span>
                        {(ops.radios[0]!.restarts ?? 0) > 0 &&
                          `（重开过 ${ops.radios[0]!.restarts} 次）`}
                      </>
                    )}
                  </Typography.Paragraph>
                  {ops.radios.map((r) => (
                    <Descriptions
                      key={`${r.freqMhz}|${r.channel}`}
                      size="small"
                      column={1}
                      bordered
                      styles={LABEL_NOWRAP}
                      style={{ marginBottom: 12 }}
                      title={`${r.freqMhz} MHz（${r.channel}）`}
                    >
                      <Descriptions.Item label="此刻">
                        {r.open ? (
                          <Tag color="green">静噪开着，正在收</Tag>
                        ) : (
                          <Tag>静默</Tag>
                        )}
                        {r.noiseDb !== undefined && (
                          <span className="mono"> {r.noiseDb.toFixed(1)} dB</span>
                        )}
                        {margin(r) !== undefined && (
                          <Typography.Text type="secondary">
                            {" "}
                            （离开门限还差 {margin(r)!.toFixed(1)} dB）
                          </Typography.Text>
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label="门限">
                        静默基准 {r.idleDb?.toFixed(1) ?? "还在校准"}
                        {r.openBelowDb !== undefined && (
                          <>
                            {" "}
                            dB，开 &lt;{r.openBelowDb.toFixed(1)}，关 &gt;
                            {r.closeAboveDb?.toFixed(1)}
                          </>
                        )}
                        {r.closestDb !== undefined && (
                          <Typography.Text type="secondary">
                            {" "}
                            （这次守听里最近差 {r.closestDb.toFixed(1)} dB）
                          </Typography.Text>
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label="最近一次静噪打开">
                        {r.lastOpenAt === undefined
                          ? "起来之后还没有过"
                          : `${time.at(r.lastOpenAt)}（${ago(ops.now, r.lastOpenAt)}）`}
                      </Descriptions.Item>
                    </Descriptions>
                  ))}
                </>
              )}
            </Card>

            {/* 这台机器没人看着，跑飞的轮询和内存泄漏只看磁盘看不出来。 */}
            <Card size="small" title="机器" style={{ marginBottom: 16 }}>
              <Descriptions
                size="small"
                column={1}
                bordered
                styles={LABEL_NOWRAP}
              >
                <Descriptions.Item label="负载">
                  {ops.machine.load1.toFixed(2)}
                  <Typography.Text type="secondary">
                    {" "}
                    （已除以 {ops.machine.cores} 个核，超过 1 说明排队了）
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="本进程内存">
                  {mb(ops.machine.rssBytes)}
                </Descriptions.Item>
                <Descriptions.Item label="系统内存">
                  空闲 {bytes(ops.machine.memFreeBytes)} / 共{" "}
                  {bytes(ops.machine.memTotalBytes)}
                  <Typography.Text type="secondary">
                    {" "}
                    （macOS 的空闲值偏小，看趋势）
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="录音占用">
                  {ops.recordings.files} 个，{bytes(ops.recordings.bytes)}
                  <Typography.Text type="secondary">
                    {" "}
                    （发射行过了保留期会连录音一起删，已入库的那些一直留着）
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="已经跑了">
                  {duration(ops.machine.uptimeS)}
                </Descriptions.Item>
              </Descriptions>
            </Card>

            <Card size="small" title="备份" style={{ marginBottom: 16 }}>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                打包这台机器整份日志数据库，通联和发射记录都在，不含录音文件。
              </Typography.Paragraph>
              <a href="/api/backup">下载数据库备份</a>
            </Card>

            <Card size="small" title="采集来源" style={{ marginBottom: 16 }}>
              {/* 关着不算健康问题，不在上面的告警里出现，这里另外说一句。 */}
              {!ops.brandmeisterEnabled && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="BrandMeister 查询关着，没有轮询在跑。"
                />
              )}
              <Descriptions
                size="small"
                column={1}
                bordered
                styles={LABEL_NOWRAP}
              >
                {ops.activities.map((a) => (
                  <Descriptions.Item
                    key={a.origin}
                    label={ORIGINS[a.origin] ?? a.origin}
                  >
                    {a.n} 条，最近一条{" "}
                    <span style={{ whiteSpace: "nowrap" }}>
                      {time.at(a.latest)}
                    </span>
                  </Descriptions.Item>
                ))}
                {ops.activities.length === 0 && (
                  <Descriptions.Item label="还没有">
                    一条都没采到
                  </Descriptions.Item>
                )}
              </Descriptions>
            </Card>

            <Card size="small" title="配置" style={{ marginBottom: 16 }}>
              <Descriptions
                size="small"
                column={1}
                bordered
                styles={LABEL_NOWRAP}
              >
                <Descriptions.Item label="聚类间隔阈值">
                  {ops.clusterGapS} 秒
                  <Typography.Text type="secondary">
                    {" "}
                    （要用真实流量实测定下来）
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="发射保留期">
                  {ops.activityRetentionDays} 天
                </Descriptions.Item>
                <Descriptions.Item label="待确认队列回看">
                  {ops.pendingWindowDays} 天
                </Descriptions.Item>
                {ops.queries.map((q) => (
                  <Descriptions.Item
                    key={q.key}
                    label={
                      <span className="mono token" title={q.key}>
                        {q.key}
                      </span>
                    }
                  >
                    每 {q.intervalS} 秒一次，每次取 {q.amount} 行
                  </Descriptions.Item>
                ))}
              </Descriptions>
            </Card>

            <Card className="flush-card" title="最近的采集">
              {wide ? (
                <Table
                  rowKey={(r) => `${r.queryKey}-${r.at}`}
                  size="small"
                  columns={columns}
                  dataSource={ops.polls}
                  pagination={false}
                  scroll={{ x: 760, y: 420 }}
                  locale={{ emptyText: "还没有采集记录" }}
                />
              ) : (
                // 手机上一次一行。表格要横滚才看得到计数，自带的纵向滚动还会把整页的滑动截住。
                <List
                  size="small"
                  dataSource={ops.polls}
                  locale={{ emptyText: "还没有采集记录" }}
                  renderItem={(r) => (
                    <List.Item>
                      <div style={{ width: "100%" }}>
                        <div className="pending-card-top">
                          <Typography.Text type="secondary">
                            {time.atShort(r.at)}
                          </Typography.Text>
                          <span className="mono token" title={r.queryKey}>
                            {r.queryKey}
                          </span>
                        </div>
                        <span className="mono">
                          {r.fetched} / {r.parsed} / {r.written}
                        </span>
                        <Typography.Text type="secondary">
                          {" "}
                          取回 / 解析 / 写入，{r.ms} ms{" "}
                        </Typography.Text>
                        {r.ok ? (
                          <Tag color="green">正常</Tag>
                        ) : (
                          <>
                            <Tag color="red">失败</Tag>
                            <span className="mono">{r.errorMsg}</span>
                          </>
                        )}
                      </div>
                    </List.Item>
                  )}
                />
              )}
            </Card>
          </>
        )}
      </AsyncContent>
    </>
  );
}
