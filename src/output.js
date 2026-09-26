// output.js — Writers for JSON, JSONL, CSV and Markdown.
// Markdown output is optimized for LLM context windows and AI agents.

import fs from 'node:fs';

function flatten(t) {
  return {
    id: t.id,
    url: t.url,
    created_at: t.created_at,
    username: t.author?.username,
    name: t.author?.name,
    verified: t.author?.verified,
    text: (t.text || '').replace(/\s+/g, ' ').trim(),
    lang: t.lang,
    replies: t.metrics?.replies,
    reposts: t.metrics?.reposts,
    quotes: t.metrics?.quotes,
    likes: t.metrics?.likes,
    bookmarks: t.metrics?.bookmarks,
    views: t.metrics?.views,
    hashtags: (t.hashtags || []).join(' '),
    links: (t.links || []).join(' '),
    media: (t.media || []).map((m) => m.video_url || m.url).join(' '),
    scraped_at: t.scraped_at,
  };
}

function csvEscape(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toJSON(tweets) {
  return JSON.stringify(tweets, null, 2);
}

export function toJSONL(tweets) {
  return tweets.map((t) => JSON.stringify(t)).join('\n') + '\n';
}

export function toCSV(tweets) {
  const rows = tweets.map(flatten);
  const headers = Object.keys(rows[0] || flatten({}));
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  return lines.join('\n') + '\n';
}

/** LLM-ready Markdown: one compact block per tweet, token-friendly. */
export function toMarkdown(tweets, { title = 'X scrape results' } = {}) {
  const parts = [`# ${title}`, '', `_Collected ${tweets.length} posts — ${new Date().toISOString()}_`, ''];
  for (const t of tweets) {
    const m = t.metrics || {};
    parts.push(`## @${t.author?.username ?? 'unknown'} — ${t.created_at ?? ''}`);
    parts.push('');
    parts.push(t.text || '');
    parts.push('');
    parts.push(
      `- likes ${m.likes ?? 0} · reposts ${m.reposts ?? 0} · replies ${m.replies ?? 0}` +
        (m.views ? ` · views ${m.views}` : '') +
        (t.url ? ` · ${t.url}` : '')
    );
    if (t.media?.length) {
      for (const md of t.media) parts.push(`- media: ${md.video_url || md.url}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

const WRITERS = { json: toJSON, jsonl: toJSONL, csv: toCSV, md: toMarkdown, markdown: toMarkdown };

export function write(tweets, { format = 'json', out, title } = {}) {
  const writer = WRITERS[format];
  if (!writer) throw new Error(`Unknown format "${format}". Use: json, jsonl, csv, md`);
  const body = format === 'md' || format === 'markdown' ? writer(tweets, { title }) : writer(tweets);
  if (out) {
    fs.writeFileSync(out, body, 'utf8');
    console.log(`Wrote ${tweets.length} items -> ${out}`);
  } else {
    process.stdout.write(body + (body.endsWith('\n') ? '' : '\n'));
  }
}
