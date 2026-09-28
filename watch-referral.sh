#!/usr/bin/env bash
# watch-referral — pantau postingan X BARU (hari ini + kemarin) berisi URL tertentu.
#
# Kenapa dibatasi: hasil pencarian sering memuat tweet lama (bulan/tahun lalu)
# yang tidak relevan. Script ini membuang semua yang lebih tua dari kemarin.
#
# Output sengaja minimal: hanya tanggal posting, URL yang ditemukan, dan URL
# sumber (tweet-nya). Kalau tidak ada yang baru, cetak NOL byte supaya cron
# tidak mengirim notifikasi kosong (pola watchdog).
set -uo pipefail

QUERY="${1:-claude.ai/referral}"
LIMIT="${2:-40}"
WINDOW_DAYS="${WINDOW_DAYS:-2}"          # 2 = hari ini + kemarin
STATE_FILE="$HOME/.xscraper/watch/$(echo "$QUERY" | tr -c 'a-zA-Z0-9' '_').seen"
mkdir -p "$(dirname "$STATE_FILE")"
touch "$STATE_FILE"

OUT="$(mktemp /tmp/urlhunt-XXXXXX.json)"
trap 'rm -f "$OUT"' EXIT

cd "$HOME/x-scraper-no-api" || exit 0
timeout 500 ./urlhunt "$QUERY" --limit "$LIMIT" --out "$OUT" >/dev/null 2>&1
[ -s "$OUT" ] || exit 0

QUERY="$QUERY" WINDOW_DAYS="$WINDOW_DAYS" STATE_FILE="$STATE_FILE" OUT="$OUT" python3 <<'PY'
import json, os, re
from datetime import datetime, timezone

query = os.environ["QUERY"]
window = int(os.environ["WINDOW_DAYS"])
state_path = os.environ["STATE_FILE"]
out_path = os.environ["OUT"]

try:
    data = json.load(open(out_path))
except Exception:
    raise SystemExit(0)

seen = {ln.strip() for ln in open(state_path) if ln.strip()}

# X menampilkan tanggal dalam bahasa Inggris: "6:16 AM · Dec 17, 2025"
# atau "8:46 PM · Jul 3" untuk tahun berjalan.
MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"])}

def parse_date(t):
    """Kembalikan datetime UTC dari field datetime/date, atau None."""
    raw = (t.get("datetime") or t.get("date") or "").strip()
    if not raw:
        return None
    m = re.search(r"([A-Z][a-z]{2})\s+(\d{1,2})(?:,\s*(\d{4}))?", raw)
    if not m:
        return None
    mon = MONTHS.get(m.group(1))
    if not mon:
        return None
    day = int(m.group(2))
    # Tanpa tahun -> X menyembunyikan tahun untuk tweet tahun berjalan.
    year = int(m.group(3)) if m.group(3) else datetime.now(timezone.utc).year
    try:
        return datetime(year, mon, day, tzinfo=timezone.utc)
    except ValueError:
        return None

now = datetime.now(timezone.utc)
today = now.replace(hour=0, minute=0, second=0, microsecond=0)
cutoff = today.timestamp() - (window - 1) * 86400  # hari ini + (window-1) hari ke belakang

def extract_urls(text):
    urls = []
    for m in re.findall(r'https?://[^\s)"\'<>]+', text or ""):
        urls.append(m.rstrip('.,;'))
    for m in re.findall(r'(?<![\w./])((?:[a-z0-9-]+\.)+[a-z]{2,}(?:/[^\s)"\']*)?)', text or "", re.I):
        if m.lower().startswith(("http", "www.")) or "/" in m:
            urls.append("https://" + m if not m.startswith("http") else m)
    return urls

new, skipped_old, undated = [], 0, 0
for t in data.get("tweets", []):
    if not t.get("matches_query"):
        continue
    tid = str(t.get("id") or "")
    if not tid or tid in seen:
        continue
    when = parse_date(t)
    if when is None:
        undated += 1
        continue          # tanpa tanggal -> tidak bisa dipastikan baru -> buang
    if when.timestamp() < cutoff:
        skipped_old += 1
        continue          # terlalu tua (bulan/tahun lalu) -> buang
    urls = [u for u in (t.get("links") or []) if "referral" in u.lower()]
    if not urls:
        urls = extract_urls(t.get("text") or "")
    new.append({
        "id": tid,
        "source": t.get("url", ""),
        "when": t.get("datetime") or t.get("date") or "",
        "urls": urls,
    })

if skipped_old or undated:
    import sys
    print(f"[pantau] dilewati: {skipped_old} lama, {undated} tanpa tanggal", file=sys.stderr)

if not new:
    raise SystemExit(0)   # watchdog: tidak ada output = tidak ada notifikasi

lines = []
with open(state_path, "a") as fh:
    for it in new:
        fh.write(f"{it['id']}\n")
        head = f"[{it['when']}] " if it["when"] else ""
        for u in it["urls"]:
            lines.append(head + u)
        lines.append(head + it["source"])
        lines.append("")

print("\n".join(lines).rstrip())
PY
