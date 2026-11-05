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
# Each file in src/site/pages/ is a page named after the file, picked by data-page in its .html. Listing them here
# means a new page adds files and edits none. Sorted, so the bundle and its hash stay the same for the same files.
gen=src/site/pages.gen.js
pages=$(cd src/site/pages && ls *.jsx 2>/dev/null | LC_ALL=C sort || true)
{
  i=0; for f in $pages; do echo "import p$i from './pages/$f';"; i=$((i+1)); done
  printf 'export default {'; i=0; for f in $pages; do printf "'%s':p%d," "${f%.jsx}" "$i"; i=$((i+1)); done; echo '};'
} > "$gen"
# The entries share no chunks, so each page loads one script and one stylesheet. wc.js (WalletConnect) loads only when someone picks a phone wallet.
"$bun" build src/site/site.jsx src/app/main.tsx --outdir public --target browser --format iife --production --entry-naming "[name].[ext]" >/dev/null
# WalletConnect uses import.meta, so it is an ES module that app.js loads with type="module".
"$bun" build src/walletconnect/wc.ts --outdir public --target browser --format esm --production --entry-naming "[name].[ext]" >/dev/null
mv public/main.js public/app.js && mv public/main.css public/app.css
cd public
find . -type f | LC_ALL=C sort | xargs shasum -a 256 | tee /dev/stderr | shasum -a 256 | cut -d' ' -f1
