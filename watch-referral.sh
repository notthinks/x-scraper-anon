#!/usr/bin/env bash
# watch-referral — pantau postingan X berisi URL tertentu; cetak HANYA yang baru.
#
# Output sengaja minimal: hanya URL yang ditemukan + URL sumber (tweet-nya).
# Tidak ada teks tweet, nama akun, atau metrik.
#
# Dipakai oleh cron. Prinsip watchdog: kalau tidak ada yang baru, keluarkan
# NOL byte supaya tidak ada notifikasi yang dikirim.
set -euo pipefail

QUERY="${1:-claude.ai/referral}"
FOUND_URL="${2:-}"          # URL yang dicari di dalam teks tweet (opsional)
REPO="$HOME/x-scraper-no-api"
STATE_DIR="$HOME/.xscraper/watch"
STATE="$STATE_DIR/$(printf '%s' "$QUERY" | tr -c 'A-Za-z0-9' '_').seen"
mkdir -p "$STATE_DIR"
touch "$STATE"

# WARP wajib: tanpa ini X balas 403
if ! warp-cli --accept-tos status 2>/dev/null | grep -q "Connected"; then
  warp-cli --accept-tos mode warp >/dev/null 2>&1 || true
  warp-cli --accept-tos connect >/dev/null 2>&1 || true
  sleep 5
fi

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

# Diamkan stdout urlhunt (JSON besar); stderr tetap masuk supaya error terlihat
if ! timeout 300 xvfb-run -a --server-args="-screen 0 1280x2000x24" \
     node "$REPO/src/urlhunt.js" "$QUERY" --limit 25 --out "$OUT" >/dev/null 2>&1; then
  echo "[watch] urlhunt gagal dijalankan" >&2
  exit 0   # jangan bikin alert error; cukup diam
fi

# Bandingkan dengan yang sudah pernah dilaporkan
python3 - "$OUT" "$STATE" "$QUERY" "$FOUND_URL" <<'PY'
import json, re, sys, os

out_path, state_path, query, found_url = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    data = json.load(open(out_path))
except Exception:
    sys.exit(0)

seen = set()
if os.path.exists(state_path):
    seen = {l.strip() for l in open(state_path) if l.strip()}

def extract_urls(text):
    """Ambil URL http(s) yang benar-benar tertulis di dalam teks tweet."""
    if not text:
        return []
    urls = re.findall(r'https?://[^\s)"\']+', text)
    # X memangkas URL jadi "claude.ai/referral/SE-Ja…" tanpa skema.
    # Tangkap juga bentuk tanpa skema itu.
    for m in re.findall(r'(?<![\w./])((?:[a-z0-9-]+\.)+[a-z]{2,}(?:/[^\s)"\']*)?)', text, re.I):
        if m.lower().startswith(('http', 'www.')) or '/' in m:
            urls.append('https://' + m if not m.startswith('http') else m)
    return urls

new = []
for t in data.get("tweets", []):
    if not t.get("matches_query"):
        continue
    tid = str(t.get("id") or "")
    if not tid or tid in seen:
        continue
    # Utamakan URL dari atribut href (utuh). Fallback ke regex teks kalau kosong.
    urls = [u for u in (t.get("links") or []) if "referral" in u.lower()]
    if not urls:
        urls = extract_urls(t.get("text") or "")
    new.append({"id": tid, "source": t.get("url", ""), "date": t.get("date") or "", "datetime": t.get("datetime") or "", "urls": urls})

if not new:
    sys.exit(0)  # watchdog: tidak ada output = tidak ada notifikasi

lines = []
with open(state_path, "a") as fh:
    for item in new:
        fh.write(f"{item['id']}\n")
        # Tanggal posting (kalau terbaca) + URL yang ditemukan + URL sumber.
        when = item["datetime"] or item["date"]
        head = f"[{when}] " if when else ""
        for u in item["urls"]:
            lines.append(head + u)
        lines.append(head + item["source"])
        lines.append("")

print("\n".join(lines).rstrip())
PY
