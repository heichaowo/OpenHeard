#!/bin/bash
# 把 api 和 daemon 装成 LaunchAgent，让它们开机自己起、崩了自己重来。
#
#   infra/install.sh [配置文件路径]
#
# 用 LaunchAgent 而不是 LaunchDaemon：不用 sudo，以本人身份跑，
# Homebrew 的路径和家目录里的配置都直接可用，USB 设备也没有额外的权限问题。
# 代价是要保持登录状态，Mac mini 开自动登录即可。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${1:-$REPO/openheard.config.json}"
LOGS="$HOME/Library/Logs/openheard"
AGENTS="$HOME/Library/LaunchAgents"
NODE="$(command -v node || true)"
PREFIX="uk.co.protocol7.openheard"
PORT="${OPENHEARD_PORT:-3000}"

die() { echo "错误：$*" >&2; exit 1; }

[ -n "$NODE" ] || die "找不到 node"
[ -f "$CONFIG" ] || die "找不到配置文件 $CONFIG"

# 配置错了照样装进去，就变成一个每 30 秒重启一次、谁也看不见的循环。
echo "== 先验配置 =="
node "$REPO/api/src/check-config.ts" "$CONFIG" || die "配置不过，先改配置再装"

command -v rtl_fm >/dev/null || echo "提醒：PATH 里没有 rtl_fm，模拟守听会起不来"

# 配置里有 ingestToken 和 sessionSecret，不该让同机别的账户读到。
chmod 600 "$CONFIG"

mkdir -p "$LOGS" "$AGENTS"

install_one() {
  local name="$1" label="$PREFIX-$1" plist="$AGENTS/$PREFIX-$1.plist"
  sed -e "s|__LABEL__|$label|g" \
      -e "s|__NODE__|$NODE|g" \
      -e "s|__REPO__|$REPO|g" \
      -e "s|__CONFIG__|$CONFIG|g" \
      -e "s|__LOGS__|$LOGS|g" \
      -e "s|__PORT__|$PORT|g" \
      -e "s|__PATH__|$(dirname "$NODE"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin|g" \
      "$REPO/infra/openheard-$name.plist.template" > "$plist"

  # bootout 是异步的，紧跟着 bootstrap 会撞上 "Input/output error"。
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "gui/$UID/$label" >/dev/null 2>&1 || break
    sleep 0.5
  done

  launchctl bootstrap "gui/$UID" "$plist"
  launchctl enable "gui/$UID/$label"
  echo "装好 $label"
}

echo "== 装 LaunchAgent =="
install_one api
install_one daemon

echo
echo "== 状态 =="
sleep 3
for n in api daemon; do
  launchctl print "gui/$UID/$PREFIX-$n" 2>/dev/null | grep -E "^\t(state|pid) " | sed "s/^/  $n /" || echo "  $n 没起来，看 $LOGS/$n.err.log"
done

echo
if curl -fsS -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "健康检查通过：http://127.0.0.1:$PORT/health"
else
  echo "健康检查没通过，看 $LOGS/api.err.log"
fi

echo
echo "日志在 $LOGS"
echo "停掉：infra/uninstall.sh"
echo
echo "这台机器如果会睡眠，守护进程会跟着停。要它一直醒着："
echo "  sudo pmset -a sleep 0"
