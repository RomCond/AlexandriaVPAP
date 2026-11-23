#!/usr/bin/env bash
# Follows the whole Cover Art Archive chain one hop at a time, for each cover and size given.
#
#   bash docs/investigations/random-cover-speed/measure-archive.sh <release-group-id>...
#
# Pass 1, cold: every hop is its own curl, so every hop opens a new connection. Prints one line per
#   hop with its timings, its size and the headers that decide caching and cross-origin reads.
# Pass 2, warm: one curl follows all chains for 500px and 1200px in turn, reusing connections the way
#   a browser tab would. Prints one line per chain.
# Requests go one at a time, with a pause between chains. PASSES="1" or PASSES="2" runs one pass only.
# A failed request prints an error line and the script carries on with the next chain.
set -uo pipefail
passes="${PASSES:-1 2}"

ua="alexandria-investigation/0.1"
origin="http://localhost:8080"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

header() { grep -i "^$1:" "$tmp/h" | head -1 | sed -E "s/^[^:]+: *//" | tr -d '\r' || true; }

if [[ "$passes" == *1* ]]; then
echo -e "# pass 1, cold\ncover\tsize\thop\thost\tcode\thttp\tsetup_ms\tttfb_ms\ttotal_ms\tbytes\tcache_control\texpires\tlast_modified\tetag\tacao"
for id in "$@"; do
  for size in 250 500 1200; do
    url="https://coverartarchive.org/release-group/$id/front-$size"
    for hop in 1 2 3 4 5; do
      if ! out=$(curl -sS -o /dev/null -D "$tmp/h" -A "$ua" -H "Origin: $origin" \
        -w '%{http_code}\t%{http_version}\t%{time_appconnect}\t%{time_starttransfer}\t%{time_total}\t%{size_download}' "$url" 2>&1); then
        echo -e "${id:0:8}\t$size\t$hop\terror\t$out"
        break
      fi
      IFS=$'\t' read -r code http setup ttfb total bytes <<< "$out"
      host=$(echo "$url" | sed -E 's#https?://([^/]+)/.*#\1#')
      ms() { awk "BEGIN { printf \"%d\", $1 * 1000 }"; }
      echo -e "${id:0:8}\t$size\t$hop\t$host\t$code\th$http\t$(ms "$setup")\t$(ms "$ttfb")\t$(ms "$total")\t$bytes\t$(header cache-control)\t$(header expires)\t$(header last-modified)\t$(header etag)\t$(header access-control-allow-origin)"
      loc=$(header location)
      [ -z "$loc" ] && break
      url="$loc"
    done
    sleep 1
  done
done
fi

[[ "$passes" == *2* ]] || exit 0
echo -e "# pass 2, warm, one connection pool\ncover\tsize\tredirects\tredirect_ms\ttotal_ms\tbytes\tfinal_host"
args=()
for id in "$@"; do
  for size in 500 1200; do args+=(-o /dev/null "https://coverartarchive.org/release-group/$id/front-$size"); done
done
# -w applies to every transfer, so each line names its own URL and awk turns it back into cover and size.
curl -sS -L --rate 1/s -A "$ua" -H "Origin: $origin" \
  -w '%{url}\t%{num_redirects}\t%{time_redirect}\t%{time_total}\t%{size_download}\t%{url_effective}\n' "${args[@]}" \
  | awk -F'\t' 'BEGIN { OFS = "\t" } {
      split($1, parts, "/"); size = parts[6]; sub(/^front-/, "", size)
      host = $6; sub(/^https:\/\//, "", host); sub(/\/.*/, "", host)
      print substr(parts[5], 1, 8), size, $2, int($3 * 1000), int($4 * 1000), $5, host
    }'
