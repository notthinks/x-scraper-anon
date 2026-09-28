// urlhunt.js — Cari postingan X terbaru yang mengandung URL/token tertentu.
//
// Kenapa lewat search engine, bukan search X:
// x.com/search me-redirect ke halaman login untuk pengunjung anonim
// (terbukti: /i/jf/onboarding/web?...mode=login). Search engine publik tetap
// mengindeks status X, jadi kita pakai itu untuk menemukan ID tweet, lalu
// ambil isinya dengan engine DOM kita sendiri.
//
// Mode AGRESIF (default sejak v2):
//   - belasan varian query di beberapa mesin pencari
//   - paginasi (halaman 2-3) untuk tiap varian
//   - kandidat dikumpulkan TANPA batas 25
//   - verifikasi tweet paralel di beberapa tab sekaligus
//   - rotasi profil browser kalau sebuah mesin balas CAPTCHA
//
// Pemakaian:
//   node src/urlhunt.js "claude.ai/referral" [--limit 60] [--out hasil.json]
//   node src/urlhunt.js "claude.ai/referral" --tabs 5 --pages 3
//   node src/urlhunt.js "claude.ai/referral" --calm   (mode konservatif lama)

import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const profileDir = process.env.XSCRAPER_PROFILE_DIR || path.join(os.homedir(), '.xscraper', 'browser-profile');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const STATUS_RE = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/g;

function parseArgs(argv) {
  const out = { query: null, limit: 60, out: null, tabs: 5, pages: 3, calm: false, maxCandidates: 400 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = parseInt(argv[++i], 10) || 60;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--tabs') out.tabs = Math.max(1, Math.min(8, parseInt(argv[++i], 10) || 5));
    else if (a === '--pages') out.pages = Math.max(1, Math.min(5, parseInt(argv[++i], 10) || 3));
    else if (a === '--max') out.maxCandidates = parseInt(argv[++i], 10) || 400;
    else if (a === '--calm') { out.calm = true; out.tabs = 1; out.pages = 1; out.limit = 25; }
    else if (!out.query) out.query = a;
  }
  return out;
}

/** Daftar mesin + URL pencarian. Beberapa mesin supaya tidak bergantung satu. */
function engineUrl(engine, query, page) {
  const offset = (page - 1) * 10;
  switch (engine) {
    case 'brave':
      return `https://search.brave.com/search?q=${encodeURIComponent(query)}${page > 1 ? `&offset=${page}` : ''}`;
    case 'ddg':
      // DDG HTML memakai POST untuk halaman berikutnya; pakai param "s" yang
      // masih dihormati sebagian, plus "dc" sebagai penanda posisi.
      return page === 1
        ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
        : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&s=${offset}&dc=${offset + 1}`;
    case 'litenet':
      return `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}${page > 1 ? `&s=${offset}` : ''}`;
    case 'bing':
      return `https://www.bing.com/search?q=${encodeURIComponent(query)}${page > 1 ? `&first=${offset + 1}` : ''}`;
    case 'marginalia':
      return `https://search.marginalia.nu/search?query=${encodeURIComponent(query)}`;
    case 'startpage':
      return `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`;
    case 'mojeek':
      return `https://www.mojeek.com/search?q=${encodeURIComponent(query)}${page > 1 ? `&s=${offset}` : ''}`;
    case 'searchapi':
      // Searx public instance sering longgar
      return `https://searx.be/search?q=${encodeURIComponent(query)}&format=json&pageno=${page}`;
    default:
      return `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
  }
}

/** Ambil semua link status X dari sebuah halaman pencarian. */
async function findStatusLinks(page, engine, query, pageNo) {
  await page.goto(engineUrl(engine, query, pageNo), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);

  // deteksi blokir/CAPTCHA supaya bisa dilewati cepat
  const blocked = await page.evaluate(() => {
    const t = (document.body.innerText || '').toLowerCase();
    return /verify|verifying|captcha|unusual traffic|automated queries|forbidden/i.test(t);
  });

  const html = await page.content();
  const found = new Map();
  let m;
  STATUS_RE.lastIndex = 0;
  while ((m = STATUS_RE.exec(html)) !== null) {
    found.set(m[2], { id: m[2], username: m[1], url: `https://x.com/${m[1]}/status/${m[2]}` });
  }
  return { links: [...found.values()], blocked };
}

/** Buka konteks dengan profil ke-N (rotasi kalau kena blokir). */
async function openProfile(slot) {
  const dir = slot === 0
    ? profileDir
    : `${profileDir}-r${slot}`;
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1280, height: 2000 },
    userAgent: UA,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  return ctx;
}

/**
 * Kumpulkan kandidat secara agresif.
 *
 * Jangan pakai tanda kutip: query berkutip menuntut frasa persis dan menolak
 * halaman yang memuat URL di dalam kartu tautan (kasus umum di X).
 *
 * Kalau sebuah mesin memblokir, pindah ke profil browser berikutnya dan
 * ulangi varian itu di sana: blokir biasanya menempel pada cookie/profil,
 * bukan pada IP.
 */
async function harvestCandidates(page, opts) {
  const q = opts.query;
  const host = q.replace(/^https?:\/\//, '');
  const tail = host.split('/').pop();

  // Urutan penting: mesin yang paling produktif dulu, lalu cadangan.
  // Yandex/Ecosia/Startpage sering CAPTCHA dari IP datacenter, jadi tidak
  // dipakai sebagai sumber utama.
  const variants = [
    ['ddg', `${host} x.com`],
    ['ddg', `${host} twitter.com`],
    ['ddg', `${host} status referral`],
    ['ddg', `${tail} claude referral`],
    ['ddg', `"${host}"`],
    ['litenet', `${host} x.com`],
    ['litenet', `${host} status`],
    ['brave', `${host} x.com`],
    ['brave', `${host} site:x.com`],
    ['brave', `${host} twitter status`],
    ['brave', `${host} referral`],
    ['brave', `${tail} claude referral`],
    ['brave', `"${host}" x.com`],
    ['bing', `${host} x.com`],
    ['bing', `${host} site:twitter.com`],
    ['marginalia', `${host}`],
    ['mojeek', `${host} x.com`],
  ];

  const found = new Map();
  const absorb = (list) => { for (const it of list) if (!found.has(it.id)) found.set(it.id, it); };
  const enginesBlocked = new Set();

  // Mesin yang sedang diblokir dilewati supaya tidak buang waktu.
  for (const [engine, v] of variants) {
    if (found.size >= opts.maxCandidates) break;
    if (enginesBlocked.has(engine)) continue;

    for (let p = 1; p <= opts.pages; p++) {
      try {
        const { links, blocked } = await findStatusLinks(page, engine, v, p);
        if (blocked) {
          enginesBlocked.add(engine);
          console.error(`[urlhunt] ${engine} diblokir, dilewati`);
          break;
        }
        const before = found.size;
        absorb(links);
        const gained = found.size - before;
        console.error(`[urlhunt] ${engine} p${p} "${v.slice(0, 28)}" +${gained} -> ${found.size}`);
        if (links.length === 0) break;   // halaman kosong = tidak ada lagi
      } catch (e) {
        console.error(`[urlhunt] ${engine} p${p} gagal: ${e.message.slice(0, 44)}`);
        break;
      }
      await page.waitForTimeout(opts.calm ? 2000 : 700);
    }
  }
  return [...found.values()];
}

/** Ekstrak data satu tweet dari halaman status yang sudah dimuat. */
async function extractFromPage(page, id) {
  return page.evaluate((tid) => {
    for (const art of document.querySelectorAll('article')) {
      const link = art.querySelector('a[href*="/status/"]');
      const m = (link?.getAttribute('href') || '').match(/^\/([^/]+)\/status\/(\d+)/);
      if (!m || m[2] !== tid) continue;

      const lines = art.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
      const name0 = lines[0] || null;
      let end = lines.length;
      if (name0) {
        for (let k = 2; k < lines.length; k++) {
          if (lines[k] === name0) { end = k; break; }
        }
      }
      const text = lines.slice(0, end).join('\n');

      let datetime = null;
      let dateShort = null;
      for (const l of lines) {
        const dm = l.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM))\s*·\s*([A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)$/i);
        if (dm) { datetime = dm[1] + ' · ' + dm[2]; dateShort = dm[2]; break; }
      }
      if (!datetime) {
        for (const l of lines) {
          const dm = l.match(/^([A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)$/);
          if (dm) { datetime = dm[1]; dateShort = dm[1]; break; }
        }
      }

      // URL LENGKAP ada di atribut href <a>, bukan di teksnya.
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
}

/** Ambil satu tweet di tab tertentu. */
async function fetchTweet(page, id) {
  await page.goto(`https://x.com/i/status/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4200);   // agresif: tunggu lebih singkat
  const data = await extractFromPage(page, id);
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

/** Cocokkan token yang dicari terhadap teks DAN tautan lengkap. */
function isMatch(t, query) {
  const needle = query.toLowerCase();
  const bare = needle.replace(/^https?:\/\//, '');
  const hay = (t.text || '').toLowerCase();
  const linkHay = (t.links || []).map((u) => u.toLowerCase()).join(' ');
  return (
    hay.includes(needle) || hay.includes(bare) ||
    linkHay.includes(needle) || linkHay.includes(bare) ||
    (t.links || []).some((u) => u.toLowerCase().includes(needle.split('/').pop()))
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error('Pemakaian: node src/urlhunt.js "claude.ai/referral" [--limit 60] [--out hasil.json] [--tabs 5] [--pages 3] [--calm]');
    process.exit(1);
  }

  const ctx = await openProfile(0);

  const searchPage = ctx.pages()[0] || (await ctx.newPage());

  console.error(`[urlhunt] mode=${args.calm ? 'kalem' : 'AGRESIF'} tabs=${args.tabs} pages=${args.pages} limit=${args.limit}`);
  console.error(`[urlhunt] mencari "${args.query}"…`);
  let hits = await harvestCandidates(searchPage, args);
  console.error(`[urlhunt] ${hits.length} kandidat status ditemukan`);
  try { await searchPage.close(); } catch {}

  // Kalau hasilnya sedikit, kemungkinan kena blokir lembut. Coba profil kedua:
  // blokir sering menempel pada cookie, bukan IP, jadi profil baru menembusnya.
  let extraCtx = null;
  if (hits.length < 8 && !args.calm) {
    console.error(`[urlhunt] hasil tipis, coba profil kedua…`);
    try {
      extraCtx = await openProfile(1);
      const p2 = extraCtx.pages()[0] || (await extraCtx.newPage());
      const hits2 = await harvestCandidates(p2, { ...args, pages: Math.max(1, args.pages - 1) });
      const seen = new Set(hits.map((h) => h.id));
      for (const h of hits2) if (!seen.has(h.id)) hits.push(h);
      console.error(`[urlhunt] total setelah profil kedua: ${hits.length}`);
    } catch (e) {
      console.error(`[urlhunt] profil kedua gagal: ${e.message.slice(0, 50)}`);
    }
  }
  const grab = extraCtx || ctx;

  // ---- Verifikasi PARALEL di beberapa tab ----
  const todo = hits.slice(0, Math.max(args.limit, hits.length));
  const results = [];
  const tabCount = Math.min(args.tabs, todo.length) || 1;

  // buat worker tab
  const workers = [];
  for (let i = 0; i < tabCount; i++) {
    const w = await grab.newPage();
    workers.push(w);
  }

  let idx = 0;
  const runWorker = async (page) => {
    while (idx < todo.length) {
      const my = idx++;
      const h = todo[my];
      try {
        const t = await fetchTweet(page, h.id);
        if (t) {
          t.matches_query = isMatch(t, args.query);
          results.push(t);
          console.error(`[urlhunt] ${t.username} match=${t.matches_query} links=${(t.links || []).length}`);
        }
      } catch (e) {
        console.error(`[urlhunt] gagal ${h.id}: ${e.message.slice(0, 50)}`);
      }
    }
  };
  await Promise.all(workers.map((w) => runWorker(w)));

  // urutkan: paling banyak tautan referral dulu, lalu yang match
  results.sort((a, b) => {
    const la = (a.links || []).filter((u) => u.includes('referral')).length;
    const lb = (b.links || []).filter((u) => u.includes('referral')).length;
    if (lb !== la) return lb - la;
    return (b.matches_query ? 1 : 0) - (a.matches_query ? 1 : 0);
  });

  const payload = {
    query: args.query,
    scraped_at: new Date().toISOString(),
    mode: args.calm ? 'calm' : 'aggressive',
    candidates: hits.length,
    count: results.length,
    matched: results.filter((t) => t.matches_query).length,
    tweets: results,
  };
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(payload, null, 2));
    console.error(`[urlhunt] disimpan ke ${args.out}`);
  }
  console.log(JSON.stringify(payload, null, 2));
  if (extraCtx) { try { await extraCtx.close(); } catch {} }
  await ctx.close();
}

main();
