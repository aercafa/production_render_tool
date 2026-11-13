#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN=node
if [ -x runtime/node ]; then
  NODE_BIN=./runtime/node
fi
if [ ! -f dist/index.html ]; then
  if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) < 24 ? 1 : 0)" 2>/dev/null; then
    echo 'Install Node.js 24 LTS for the source ZIP, or download the portable ZIP from GitHub Releases.'
    exit 1
  fi
  echo 'Preparing the web application. The first build needs internet access.'
  npm ci --ignore-scripts
  npm run build
fi
exec "$NODE_BIN" server/start-web.mjs
