#!/usr/bin/env bash
# ============================================================================
# Isle Studio · macOS 一键构建
# ----------------------------------------------------------------------------
# 在任意一台 macOS 机器上执行（需 Node.js 20+，无需 Apple 开发者账号）：
#
#     bash build-mac.sh            # 同时出 Apple 芯片(arm64) + Intel(x64)
#     bash build-mac.sh arm64      # 只出 Apple 芯片
#     bash build-mac.sh x64        # 只出 Intel
#
# 产物：release/Isle Studio-<版本>-<架构>.dmg 与同名 .zip
#
# 说明：
#  - 未签名版本首次打开需「右键 → 打开」，或执行：
#      xattr -cr "/Applications/Isle Studio.app"
#  - 成片合成（FFmpeg）在 macOS 上不随包携带，需 `brew install ffmpeg`。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

ARCH="${1:-}"
if [ -n "$ARCH" ] && [ "$ARCH" != "arm64" ] && [ "$ARCH" != "x64" ]; then
  echo "用法：bash build-mac.sh [arm64|x64]" >&2
  exit 1
fi

echo "==> 检查环境"
command -v node >/dev/null || { echo "缺少 Node.js：请先安装 https://nodejs.org （20 LTS 或更高）"; exit 1; }
echo "    node $(node -v) · npm $(npm -v) · $(uname -m)"

echo "==> 安装依赖（首次约 2-4 分钟）"
npm install --no-audit --no-fund

echo "==> 生成图标（若缺失）"
[ -f build/icon.icns ] || npm run icon:icns

echo "==> 构建前端 + 打包 macOS 应用"
if [ -n "$ARCH" ]; then
  npm run "dist:mac:$ARCH" -- --publish never
else
  npm run dist:mac -- --publish never
fi

echo
echo "==> 完成，产物："
ls -lh release/*.dmg release/*.zip 2>/dev/null || true
echo
echo "首次运行提示：若提示「已损坏 / 无法验证开发者」，执行"
echo "  xattr -cr \"/Applications/Isle Studio.app\""
