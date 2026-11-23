#!/usr/bin/env bash
# Times the first hop of a Cover Art Archive cover: the 307 from coverartarchive.org.
# It never follows the redirect, so it measures only the lookup the app pays on every cover load.
#
#   bash docs/investigations/random-cover-speed/measure-redirect.sh <release-group-id>...
#
# Part 1 opens a fresh connection per request (what a first cover after page load pays).
# Part 2 sends all sizes over one kept-alive connection (what later covers pay), at most 2 a second.
set -euo pipefail

ua="alexandria-investigation/0.1"
fmt='%{http_code}\t%{time_appconnect}\t%{time_starttransfer}\t%{time_total}\t%{url_effective}\n'

echo "# cold: code, tls_done_s, ttfb_s, total_s, url"
for id in "$@"; do
  curl -sS -o /dev/null -A "$ua" -H "Origin: http://localhost:8080" -w "$fmt" \
    "https://coverartarchive.org/release-group/$id/front-1200"
  sleep 1
done

echo "# warm, one connection: code, tls_done_s, ttfb_s, total_s, url"
urls=()
for id in "$@"; do
  for size in 250 500 1200; do
    urls+=("https://coverartarchive.org/release-group/$id/front-$size")
  done
done
args=()
for url in "${urls[@]}"; do args+=(-o /dev/null -w "$fmt" "$url"); done
curl -sS --rate 2/s -A "$ua" -H "Origin: http://localhost:8080" "${args[@]}"
