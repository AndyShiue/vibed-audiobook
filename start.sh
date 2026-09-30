#!/bin/sh
# Starts the audiobook server on macOS / Linux — the counterpart of start.bat.
#
#   ./start.sh            (once:  chmod +x start.sh      or just run:  sh start.sh)
#   ./start.sh --mock     try the app without any API key (fake AI answers)
#
# Put HTTPS=1 in .env to use the app from a phone on your Wi-Fi. Extra arguments go to server.js.

case $0 in */*) cd "${0%/*}" || exit 1 ;; esac

fail() {
  printf '\n  %s\n\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install the current LTS from https://nodejs.org/ (macOS: brew install node), then run this again."

# server.js needs Node 20.12 or newer
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 12) ? 0 : 1)' ||
  fail "This app needs Node.js 20.12 or newer, but this is $(node -v). Install the current LTS from https://nodejs.org/."

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies (npm install) ..."
  npm install || fail "npm install failed — see the messages above."
fi

exec node server.js "$@"
