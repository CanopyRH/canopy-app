#!/bin/sh
# tsc needs a JS runtime; this project only ships Bun.
exec "$(dirname "$0")/../.tools/bun/v1.4.4/bun" "$(dirname "$0")/node_modules/typescript/lib/tsc.js" --noEmit -p "$(dirname "$0")"
