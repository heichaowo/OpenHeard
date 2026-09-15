// BrandMeister Last Heard 的 searchHouse 查询。
//
// 手写 engine.io/socket.io 帧序列，不用客户端库。协议和它的陷阱写在
// specs/openheard.md 的「BrandMeister 接入协议」一节。

const ENDPOINT = 'wss://api.brandmeister.network/lh/?EIO=4&transport=websocket';

export interface Rule {
  id: string;
  operator: string;
  value: number | string;
}

export interface FetchOptions {
  amount: number;
  /** 最后一行之后等多久收尾。searchHouseComplete 正常会先到。 */
  idleMs?: number;
  /** 整次查询的上限。 */
  timeoutMs?: number;
}

export interface FetchResult {
  rows: Record<string, unknown>[];
  /** searchHouseComplete 有没有到。没到说明是被超时收的尾。 */
  complete: boolean;
  ms: number;
}

/**
 * 发送前自己校验。
 *
 * 服务端对畸形查询一律静默返回空集，不报错也不断连，所以错误必须在这里拦住。
 * 空 rules 更危险：它返回的是全网最新记录。
 */
export function checkRules(rules: Rule[]): void {
  if (rules.length === 0) {
    throw new Error('rules 不能为空，空 rules 返回的是全网最新记录');
  }
  for (const r of rules) {
    if (/ID$/.test(r.id) && typeof r.value !== 'number') {
      throw new Error(`${r.id} 的 value 必须是数字，传字符串会静默返回空集`);
    }
  }
}

/**
 * 取一次历史。
 *
 * 每条规则单独一次查询，不要用 condition OR 合并：`amount` 是合并去重后的
 * 全局上限，热闹的规则会把安静的规则饿死。
 *
 * 不发 join。join 只属于订阅路径，searchHouse 不需要它，发了只会混进实时行。
 */
export async function fetchHistory(rules: Rule[], opts: FetchOptions): Promise<FetchResult> {
  checkRules(rules);
  const { amount, idleMs = 4000, timeoutMs = 25000 } = opts;
  const startedAt = Date.now();

  return await new Promise<FetchResult>((resolve, reject) => {
    const ws = new WebSocket(ENDPOINT);
    const rows: Record<string, unknown>[] = [];
    let complete = false;
    let settled = false;
    let idle: NodeJS.Timeout | undefined;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      clearTimeout(idle);
      try {
        ws.close();
      } catch {
        // 已经关了
      }
      if (err) reject(err);
      else resolve({ rows, complete, ms: Date.now() - startedAt });
    };

    const cap = setTimeout(() => finish(), timeoutMs);
    const bumpIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(), idleMs);
    };

    ws.addEventListener('error', () => finish(new Error('brandmeister websocket 出错')));
    ws.addEventListener('close', () => finish());

    ws.addEventListener('message', (ev) => {
      const d = typeof ev.data === 'string' ? ev.data : '';

      if (d.startsWith('0{')) return ws.send('40'); // engine.io OPEN
      if (d === '2') return ws.send('3'); // PING，不回就被断开
      if (d.startsWith('40')) {
        ws.send('42' + JSON.stringify(['searchHouse', { query: { condition: 'AND', rules }, amount }]));
        bumpIdle();
        return;
      }
      if (!d.startsWith('42')) return;

      let name: string;
      let arg: { payload?: unknown } | undefined;
      try {
        [name, arg] = JSON.parse(d.slice(2)) as [string, { payload?: unknown }];
      } catch {
        return;
      }

      // 历史发完的信号，在最后一行之后到。按行数上限提前退出就收不到它。
      if (name === 'searchHouseComplete') {
        complete = true;
        return finish();
      }
      if (name !== 'mqtt') return;

      let row: unknown;
      try {
        row = typeof arg?.payload === 'string' ? JSON.parse(arg.payload) : arg;
      } catch {
        return;
      }
      if (row && typeof row === 'object') rows.push(row as Record<string, unknown>);
      bumpIdle();
    });
  });
}
