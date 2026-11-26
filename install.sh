#!/bin/sh
set -eu
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { printf 'Install Node.js 22 or newer first.\n' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or newer is required."); process.exit(1); }'
npm ci --omit=dev
npm run setup
printf '\nEdit .env, create the database described in README.md, then run:\n  npm run migrate\n  npm start\n'
