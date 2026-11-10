#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
wasm-pack build core --target web --out-dir ../web/src/pkg --release
cd web
[ -d node_modules ] || npm install
npm run dev
