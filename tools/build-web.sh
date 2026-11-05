#!/bin/sh
# Builds the static web app and prints its hash, so anyone can rebuild it from the same source and compare.
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/web"
if [ "$(cat src/deployment.json)" != "{}" ] && [ "$1" != "--test" ]; then
  echo "web/src/deployment.json points at a test deployment. Set it to {} or pass --test." >&2
  exit 1
fi
bun="$root/.tools/bun/v1.4.4/bun"
[ -x "$bun" ] || bun=bun
# The entries share no chunks, so each page loads one script and one stylesheet. wc.js (WalletConnect) loads only when someone picks a phone wallet.
"$bun" build src/site/site.jsx src/app/main.tsx --outdir public --target browser --format iife --production --entry-naming "[name].[ext]" >/dev/null
# WalletConnect uses import.meta, so it is an ES module that app.js loads with type="module".
"$bun" build src/walletconnect/wc.ts --outdir public --target browser --format esm --production --entry-naming "[name].[ext]" >/dev/null
mv public/main.js public/app.js && mv public/main.css public/app.css
cd public
find . -type f | LC_ALL=C sort | xargs shasum -a 256 | tee /dev/stderr | shasum -a 256 | cut -d' ' -f1
