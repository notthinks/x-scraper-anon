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

/** Ambil teks + metrik satu tweet lewat halaman statusnya. */
async function fetchTweet(page, id) {
  await page.goto(`https://x.com/i/status/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const data = await page.evaluate((tid) => {
    // artikel pertama = tweet utama (id-nya cocok dengan yang diminta)
    for (const art of document.querySelectorAll('article')) {
      const link = art.querySelector('a[href*="/status/"]');
      if (!link) continue;
      const href = link.getAttribute('href') || '';
      const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
      if (!m || m[2] !== tid) continue;
      const lines = art.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
      // Anonim: satu <article> bisa memuat tweet utama + preview tweet lain
      // (quote/reply) yang ditempelkan setelahnya. Tweet utama berakhir ketika
      // nama tampilan penulis muncul lagi untuk kedua kalinya.
      const name0 = lines[0] || null;
      let end = lines.length;
      if (name0) {
        for (let k = 2; k < lines.length; k++) {
          if (lines[k] === name0) { end = k; break; }
        }
      }
      const own = lines.slice(0, end);

      // Metrik bisa muncul setelah tweet selesai (mis. "8:50 AM · Jan 21, 2026
      // · 11.2K Views") atau sebagai angka telanjang di ekor. Ambil dari baris
      // mentah (bukan `own`) supaya metrik yang berada di luar blok tetap kebaca.
      const expand = (s) => { const mm = String(s).match(/^([\d.,]+)\s*([KMB])?$/i); if (!mm) return undefined; let n = parseFloat(mm[1].replace(/,/g, '')); const u = (mm[2] || '').toUpperCase(); if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (u === 'B') n *= 1e9; return Math.round(n); };
      const isNum = (s) => expand(s) !== undefined;
      const metrics = {};
      // pola eksplisit: "11.2K Views"
      const joined = lines.join(' | ');
      const vw = joined.match(/([\d.,]+\s*[KMB]?)\s*Views/i);
      if (vw) metrics.views = expand(vw[1].replace(/\s+/g, ''));
      // tiga angka sebelum Views = replies, reposts, likes
      const seq = joined.match(/([\d.,]+\s*[KMB]?)\s*\|\s*([\d.,]+\s*[KMB]?)\s*\|\s*([\d.,]+\s*[KMB]?)\s*\|\s*[\d.,]+\s*[KMB]?\s*Views/i);
      if (seq) {
        metrics.replies = expand(seq[1].replace(/\s+/g, ''));
        metrics.reposts = expand(seq[2].replace(/\s+/g, ''));
        metrics.likes = expand(seq[3].replace(/\s+/g, ''));
      } else {
        const tail = [];
        for (let j = own.length - 1; j >= 0 && tail.length < 4; j--) {
          if (isNum(own[j])) tail.unshift(own[j]); else break;
        }
        if (tail[0]) metrics.replies = expand(tail[0]);
        if (tail[1]) metrics.reposts = expand(tail[1]);
        if (tail[2]) metrics.likes = expand(tail[2]);
        if (tail[3]) metrics.views = expand(tail[3]);
      }

      const idx = own[1] && own[1].startsWith('@') ? 2 : 1;
      let ci = idx;
      if (own[ci] && /^(\d+[mhd]|[A-Z][a-z]{2}\s+\d{1,2}(,\s+\d{4})?|\d{1,2}:\d{2}\s*(AM|PM))/.test(own[ci])) ci++;
      // teks = setelah tanggal, sampai sebelum ekor angka (kalau ada di dalam `own`)
      let endOwn = own.length;
      const tailIn = [];
      for (let j = own.length - 1; j >= ci && tailIn.length < 3; j--) {
        if (isNum(own[j])) tailIn.unshift(own[j]); else break;
      }
      if (tailIn.length === 3) endOwn = own.length - 3;
      const text = own.slice(ci, endOwn).join('\n').trim();
      return {
        id: tid,
        url: `https://x.com/${m[1]}/status/${tid}`,
        username: m[1],
        name: name0,
        date: own[ci - 1] || null,
        text,
        metrics,
      };
    }
    return null;
  }, id);
  return data;
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
  const hits = await findStatusLinks(page, 'brave', args.query);
  console.error(`[urlhunt] ${hits.length} kandidat status ditemukan via Brave`);

  const results = [];
  for (const h of hits.slice(0, args.limit)) {
    try {
      const t = await fetchTweet(page, h.id);
      if (t) {
        // hanya simpan kalau teksnya benar-benar mengandung token yang dicari
        const needle = args.query.toLowerCase();
        const hay = (t.text || '').toLowerCase();
        const matched = hay.includes(needle) || hay.includes(needle.replace(/^https?:\/\//, ''));
        t.matches_query = matched;
        results.push(t);
        console.error(`[urlhunt] ${t.username} (${t.date}) match=${matched} likes=${t.metrics.likes ?? '-'}`);
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
