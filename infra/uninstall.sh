#!/bin/bash
# 卸掉两个 LaunchAgent。日志和数据库都不动。
set -euo pipefail
PREFIX="uk.co.protocol7.openheard"
for n in api daemon; do
  label="$PREFIX-$n"
  launchctl bootout "gui/$UID/$label" 2>/dev/null && echo "停掉 $label" || echo "$label 本来就没跑"
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
echo "日志还在 $HOME/Library/Logs/openheard，数据库没动。"
