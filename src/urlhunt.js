// urlhunt.js — Cari postingan X terbaru yang mengandung URL/token tertentu.
//
// Kenapa lewat search engine, bukan search X:
//   x.com/search me-redirect ke halaman login untuk pengunjung anonim
//   (terbukti: /i/jf/onboarding/web?...mode=login). Brave Search tetap
//   mengindeks status X secara publik, jadi kita pakai itu untuk menemukan
//   ID tweet, lalu ambil isinya dengan engine DOM kita sendiri.
//
// Pemakaian:
//   node src/urlhunt.js "claude.ai/referral" [--limit 20] [--out hasil.json]

import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const profileDir = process.env.XSCRAPER_PROFILE_DIR || path.join(os.homedir(), '.xscraper', 'browser-profile');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const STATUS_RE = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/g;

function parseArgs(argv) {
  const out = { query: null, limit: 20, out: null, engines: ['brave'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = parseInt(argv[++i], 10) || 20;
    else if (a === '--out') out.out = argv[++i];
    else if (!out.query) out.query = a;
  }
  return out;
}

/** Ambil semua link status X dari sebuah search engine. */
async function findStatusLinks(page, engine, query) {
  const urls = {
    brave: `https://search.brave.com/search?q=${encodeURIComponent('"' + query + '"')}`,
    bing: `https://www.bing.com/search?q=${encodeURIComponent('"' + query + '" site:x.com')}`,
    ddg: `https://html.duckduckgo.com/html/?q=${encodeURIComponent('"' + query + '" x.com')}`,
  };
  await page.goto(urls[engine], { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4500);
  const html = await page.content();
  const found = new Map();
  let m;
  STATUS_RE.lastIndex = 0;
  while ((m = STATUS_RE.exec(html)) !== null) {
    found.set(m[2], { id: m[2], username: m[1], url: `https://x.com/${m[1]}/status/${m[2]}` });
  }
  return [...found.values()];
}

/**
 * Kumpulkan kandidat dari beberapa varian query Brave + paginasi.
 * Satu varian saja biasanya hanya memberi 1-2 hasil.
 */
async function harvestCandidates(page, query) {
  const variants = [
    `"${query}"`,
    `"${query}" site:x.com`,
    `"${query}" site:twitter.com`,
    `${query} claude referral`,
  ];
  const found = new Map();
  const absorb = (list) => { for (const it of list) if (!found.has(it.id)) found.set(it.id, it); };

  for (const v of variants) {
    try {
      absorb(await findStatusLinks(page, 'brave', v));
      console.error(`[urlhunt] varian "${v.slice(0, 34)}" -> total ${found.size}`);
    } catch (e) {
      console.error(`[urlhunt] varian gagal: ${e.message}`);
    }
    // jeda sopan supaya tidak kena rate-limit Brave
    await page.waitForTimeout(2500);
  }
  return [...found.values()];
}

/** Ambil teks + tautan LENGKAP + metrik satu tweet lewat halaman statusnya. */
async function fetchTweet(page, id) {
  await page.goto(`https://x.com/i/status/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  const data = await page.evaluate((tid) => {
    for (const art of document.querySelectorAll('article')) {
      const link = art.querySelector('a[href*="/status/"]');
      const m = (link?.getAttribute('href') || '').match(/^\/([^/]+)\/status\/(\d+)/);
      if (!m || m[2] !== tid) continue;

      const lines = art.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
      // Satu <article> bisa memuat tweet utama + preview tweet lain; potong
      // saat nama tampilan penulis muncul lagi.
      const name0 = lines[0] || null;
      let end = lines.length;
      if (name0) {
        for (let k = 2; k < lines.length; k++) {
          if (lines[k] === name0) { end = k; break; }
        }
      }
      const text = lines.slice(0, end).join('\n');

      // Tanggal/waktu posting: baris berformat "6:16 AM · Dec 17, 2025" atau
      // "11:40 AM · Mar 21, 2026". Tahun hilang kalau tweet dari tahun berjalan
      // ("8:46 PM · Jul 3") — itu memang perilaku X untuk tweet terkini.
      let datetime = null;
      let dateShort = null;
      for (const l of lines) {
        const dm = l.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM))\s*·\s*([A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)$/i);
        if (dm) { datetime = dm[1] + ' · ' + dm[2]; dateShort = dm[2]; break; }
      }
      if (!datetime) {
        // pola tanpa jam: "Dec 17, 2025"
        for (const l of lines) {
          const dm = l.match(/^([A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)$/);
          if (dm) { datetime = dm[1]; dateShort = dm[1]; break; }
        }
      }

      // URL LENGKAP ada di atribut href <a>, bukan di teksnya.
      // X memangkas tampilan jadi "claude.ai/referral/SE-Ja…", tetapi href
      // menyimpan target utuh. Ambil tautan non-X / non-t.co.
      const links = [];
      for (const a of art.querySelectorAll('a[href]')) {
        const raw = a.getAttribute('href') || '';
        if (/^https?:\/\//.test(raw) && !/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:x|twitter)\.com\//i.test(raw) && !raw.includes('t.co/')) {
          if (!links.includes(raw)) links.push(raw);
        }
      }
      return { username: m[1], name: name0, text, links, datetime, dateShort };
    }
    return null;
  }, id);

  if (!data) return null;
  return {
    id,
    url: `https://x.com/${data.username}/status/${id}`,
    username: data.username,
    name: data.name,
    text: data.text,
    date: data.dateShort || null,
    datetime: data.datetime || null,
    links: data.links,
    metrics: {},
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error('Pemakaian: node src/urlhunt.js "claude.ai/referral" [--limit 20] [--out hasil.json]');
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 2000 },
    userAgent: UA,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = ctx.pages()[0] || (await ctx.newPage());

  console.error(`[urlhunt] mencari "${args.query}"…`);
  const hits = await harvestCandidates(page, args.query);
  console.error(`[urlhunt] ${hits.length} kandidat status ditemukan`);

  const results = [];
  for (const h of hits.slice(0, args.limit)) {
    try {
      const t = await fetchTweet(page, h.id);
      if (t) {
        // Cocokkan token yang dicari terhadap teks DAN tautan lengkap.
        // Tautan adalah sumber utama karena teks tampilan dipangkas X.
        const needle = args.query.toLowerCase();
        const bare = needle.replace(/^https?:\/\//, '');
        const hay = (t.text || '').toLowerCase();
        const linkHay = (t.links || []).map((u) => u.toLowerCase()).join(' ');
        const matched =
          hay.includes(needle) || hay.includes(bare) ||
          linkHay.includes(needle) || linkHay.includes(bare) ||
          // token pendek (mis. "gvQw"): cek juga potongan terakhir URL
          (t.links || []).some((u) => u.toLowerCase().includes(needle.split('/').pop()));
        t.matches_query = matched;
        results.push(t);
        console.error(`[urlhunt] ${t.username} match=${matched} links=${(t.links || []).length}`);
      }
    } catch (e) {
      console.error(`[urlhunt] gagal ${h.id}: ${e.message}`);
    }
  }

  const payload = { query: args.query, scraped_at: new Date().toISOString(), engine: 'brave', count: results.length, tweets: results };
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(payload, null, 2));
    console.error(`[urlhunt] disimpan ke ${args.out}`);
  }
  console.log(JSON.stringify(payload, null, 2));
  await ctx.close();
}

main();
