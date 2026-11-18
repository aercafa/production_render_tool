#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
if [ -f VERSION.txt ]; then
  printf 'Render Workbench v%s\n' "$(tr -d '\r\n' < VERSION.txt)"
fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN=node
if [ -x runtime/node ]; then
  NODE_BIN=./runtime/node
fi
NEEDS_BUILD=0
if [ -f VERSION.txt ]; then
  if [ ! -f dist/index.html ]; then
    echo 'The portable package is incomplete. Extract the entire ZIP before starting.'
    exit 1
  fi
elif ! "$NODE_BIN" scripts/source-build.mjs check >/dev/null 2>&1; then
  NEEDS_BUILD=1
fi
if [ "$NEEDS_BUILD" = 1 ]; then
  if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) < 24 ? 1 : 0)" 2>/dev/null; then
    echo 'Install Node.js 24 LTS for the source ZIP, or download the portable ZIP from GitHub Releases.'
    exit 1
  fi
  echo 'Preparing the updated web application. Installing dependencies may need internet access.'
  if ! "$NODE_BIN" scripts/source-build.mjs deps >/dev/null 2>&1; then
    npm ci --ignore-scripts
  fi
  npm run build
fi
exec "$NODE_BIN" server/start-web.mjs
