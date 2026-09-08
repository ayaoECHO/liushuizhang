#!/bin/bash
cd "$(dirname "$0")"

if lsof -i :5202 -t &>/dev/null; then
  open http://localhost:5202
  exit 0
fi

echo "流水账启动中..."
node server.js &
sleep 1
open http://localhost:5202

echo "服务已启动，关闭此窗口即可停止服务。"
wait
