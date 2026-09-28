// domfallback.js — Baca tweet dari DOM saat GraphQL tidak tersedia (mode anonim).
//
// Kenapa: X hanya mengirim respons GraphQL berisi tweet ke client yang login.
// Untuk pengunjung anonim X merender HTML server-side, TETAPI tanpa satu pun
// atribut data-testid (selector standar scraper tidak jalan). Karena itu parser
// di sini bekerja dari struktur dan innerText, bukan testid.
//
// Struktur innerText satu artikel (anonim):
//   NASA                        <- nama tampilan
//   @NASA                       <- username
//   Sep 26                      <- tanggal relatif
//   With @BoeingSpace, we'll…   <- teks tweet (bisa multi-baris)
//   221                         <- replies
//   564                         <- reposts
//   4.3K                        <- likes
//   936K                        <- views
//
// Batasan mode anonim (jujur, bukan bug):
//  - Metrik hanya dalam bentuk terformat (4.3K), bukan angka mentah.
//  - Render bersifat lazy: hanya ~5-10 tweet pertama yang ada di DOM.
//  - Scroll lebih jauh biasanya memicu login wall.

/** Ubah "4.3K" / "1.2M" / "936" menjadi angka. */
function parseCount(s) {
  if (!s) return undefined;
  const m = String(s).trim().match(/^([\d.,]+)\s*([KMB])?$/i);
  if (!m) return undefined;
  let n = parseFloat(m[1].replace(/,/g, ''));
  const unit = (m[2] || '').toUpperCase();
  if (unit === 'K') n *= 1e3;
  else if (unit === 'M') n *= 1e6;
  else if (unit === 'B') n *= 1e9;
  return Math.round(n);
}

/** Ekstrak tweet dari DOM halaman X yang sedang terbuka. */
export async function extractTweetsFromDom(page) {
  return page.evaluate(() => {
    const countOf = (s) => {
      if (!s) return undefined;
      const m = String(s).trim().match(/^([\d.,]+)\s*([KMB])?$/i);
      if (!m) return undefined;
      let n = parseFloat(m[1].replace(/,/g, ''));
      const u = (m[2] || '').toUpperCase();
      if (u === 'K') n *= 1e3;
      else if (u === 'M') n *= 1e6;
      else if (u === 'B') n *= 1e9;
      return Math.round(n);
    };

    const out = [];
    for (const article of document.querySelectorAll('article')) {
      const statusLink = article.querySelector('a[href*="/status/"]');
      if (!statusLink) continue;
      const href = statusLink.getAttribute('href') || '';
      const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
      if (!m) continue;
      const username = m[1];
      const id = m[2];
      if (out.some((t) => t.id === id)) continue;

      const lines = article.innerText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      // baris 0 = nama tampilan, baris 1 = @username (bila ada)
      let name = lines[0] || null;
      let idx = 1;
      if (lines[1] && lines[1].startsWith('@')) idx = 2;

      // tanggal relatif: "Sep 26", "2h", "5m"
      let created_at = null;
      if (lines[idx] && /^(\d+[mhd]|[A-Z][a-z]{2}\s+\d{1,2}|[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})$/.test(lines[idx])) {
        created_at = lines[idx];
        idx++;
      }

      // metrik: baris terakhir yang berupa angka/angka terformat
      const tail = [];
      for (let j = lines.length - 1; j >= idx && tail.length < 4; j--) {
        if (countOf(lines[j]) !== undefined) tail.unshift(lines[j]);
        else break;
      }
      const metrics = {};
      if (tail.length >= 1) metrics.replies = countOf(tail[0]);
      if (tail.length >= 2) metrics.reposts = countOf(tail[1]);
      if (tail.length >= 3) metrics.likes = countOf(tail[2]);
      if (tail.length >= 4) metrics.views = countOf(tail[3]);

      // teks tweet: semua baris setelah tanggal, sebelum ekor metrik
      const textEnd = lines.length - tail.length;
      const text = lines.slice(idx, textEnd).join('\n').trim();

      out.push({
        id,
        url: `https://x.com/${username}/status/${id}`,
        created_at,
        text: text || null,
        lang: null,
        author: { username, name },
        metrics,
        is_reply: false,
        is_quote: false,
        hashtags: [],
        links: [],
        media: undefined,
        source: 'dom',
      });
    }
    return out;
  });
}
