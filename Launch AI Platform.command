#!/usr/bin/env bash
# ============================================================
# Launch AI Platform — macOS Finder ダブルクリック用ランチャー
#   ・サーバが既に動いているか確認
#   ・動いてなければ起動 → http200 を確認
#   ・既定ブラウザで http://127.0.0.1:8788 を開く
#   ・ログは setup/run/ai-platform-8788.log
# 使い方：Finder でこのファイルをダブルクリック
# ============================================================
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# インストール済みの node を使う：PATH に node が見つからないケースだけ Homebrew を覗きに行く
if ! command -v node >/dev/null 2>&1; then
  for p in /opt/homebrew/bin /usr/local/bin; do
    [ -x "$p/node" ] && export PATH="$p:$PATH" && break
  done
fi
if ! command -v node >/dev/null 2>&1; then
  /usr/bin/osascript -e 'display alert "AI Platform" message "node が見つかりません。brew install node か setup/install.sh install を実行してください。" as critical buttons {"OK"}' || true
  read -rp "Press Enter to close..."
  exit 1
fi

# 既に動いてるか事前確認（ポート 8788 / AI_PLATFORM_PORT 上書き可）
PORT="${AI_PLATFORM_PORT:-8788}"
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | grep -q .; then
  echo "[$PORT] は既に誰かが LISTEN してます — 起動済みの可能性"
else
  echo "[$PORT] は空き — 新規に起動します"
fi

exec node tools/launch.mjs "$@"
