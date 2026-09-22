#!/bin/bash
# Finder entrypoint. The supervisor owns all setup and shutdown behavior.
set -u
pause_on_error() {
  # Keep a Finder-launched terminal readable without hanging CI or piped use.
  if [[ -t 0 && -t 1 ]]; then read -r -p "Returnで閉じます…"; fi
  return 0
}
cd "$(dirname "$0")" || exit 1
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/local/opt/node@22/bin"
if ! command -v node >/dev/null 2>&1; then
  echo "Node 22以降が必要です。https://nodejs.org/ から導入して、もう一度このファイルを開いてください。"
  pause_on_error
  exit 1
fi
node_major=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || [[ "$node_major" -lt 22 ]]; then
  echo "Node 22以降が必要です。現在選ばれているNodeでは起動しません。"
  echo "Nodeを更新し、ターミナルを開き直して node --version を確認してください。"
  echo "使用中のNode: $(command -v node)"
  pause_on_error
  exit 1
fi
if [[ ! -f scripts/start-local-preview.mjs ]]; then
  echo "起動に必要なソースが見つかりません。"
  echo "このファイルだけでなく、Genieのソース一式を展開したフォルダから開いてください。"
  pause_on_error
  exit 1
fi
node scripts/start-local-preview.mjs "$@"
result=$?
if [[ $result -ne 0 ]]; then
  echo "起動処理は完了していません。上に表示された問題を解消して、再度開いてください。"
  pause_on_error
fi
exit "$result"
