// scraper.js — Core engine.
//
// Instead of parsing X's obfuscated HTML (class names change weekly), we let
// the real X web app render in Chromium and passively capture the structured
// GraphQL JSON responses X sends to its own frontend. We never call private
// endpoints directly, never forge headers, and never replay requests — the
// browser does exactly what a human scrolling would do, and we read along.

import { openSession, assertLoggedIn } from './session.js';
import { RateLimiter } from './ratelimit.js';

/** Recursively collect every object that looks like a Tweet result. */
function* walkTweets(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (
    (node.__typename === 'Tweet' || node.rest_id) &&
    node.legacy &&
    typeof node.legacy.full_text === 'string'
  ) {
    yield node;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) yield* walkTweets(item, seen);
    } else if (value && typeof value === 'object') {
      yield* walkTweets(value, seen);
    }
  }
}

/** Normalize X's internal tweet shape into a clean, stable, LLM-ready schema. */
export function normalizeTweet(raw) {
  const legacy = raw.legacy || {};
  const user = raw.core?.user_results?.result;
  const userLegacy = user?.legacy || {};
  const media = (legacy.extended_entities?.media || legacy.entities?.media || []).map((m) => ({
    type: m.type,
    url: m.media_url_https,
    video_url:
      m.video_info?.variants
        ?.filter((v) => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url || undefined,
  }));

  return {
    id: raw.rest_id || legacy.id_str,
    url: userLegacy.screen_name
      ? `https://x.com/${userLegacy.screen_name}/status/${raw.rest_id || legacy.id_str}`
      : undefined,
    created_at: legacy.created_at,
    text: legacy.full_text,
    lang: legacy.lang,
    author: {
      username: userLegacy.screen_name,
      name: userLegacy.name,
      user_id: user?.rest_id,
      verified: user?.is_blue_verified ?? userLegacy.verified ?? false,
      followers: userLegacy.followers_count,
    },
    metrics: {
      replies: legacy.reply_count,
      reposts: legacy.retweet_count,
      quotes: legacy.quote_count,
      likes: legacy.favorite_count,
      bookmarks: legacy.bookmark_count,
      views: Number(raw.views?.count || 0) || undefined,
    },
    is_reply: Boolean(legacy.in_reply_to_status_id_str),
    in_reply_to_id: legacy.in_reply_to_status_id_str || undefined,
    is_quote: Boolean(legacy.is_quote_status),
    hashtags: (legacy.entities?.hashtags || []).map((h) => h.text),
    links: (legacy.entities?.urls || []).map((u) => u.expanded_url),
    media: media.length ? media : undefined,
    scraped_at: new Date().toISOString(),
  };
}

/**
 * Run a scrape job.
 *
 * @param {object} job
 * @param {string} job.url           X URL to visit (search, profile, or status page)
 * @param {number} job.limit         max items to collect
 * @param {number} job.maxScrolls    safety cap on scroll iterations
 * @param {string} job.profileDir    custom browser profile directory
 * @param {boolean} job.headless     run headless (default true)
 * @param {(tweets: object[]) => void} job.onBatch  called with each new batch
 */
export async function scrape({ url, limit = 50, maxScrolls = 40, profileDir, headless = true, onBatch }) {
  const limiter = new RateLimiter({ maxItems: limit });
  const context = await openSession({ profileDir, headless });
  const page = context.pages()[0] || (await context.newPage());

  const collected = new Map(); // id -> normalized tweet (dedupe by stable ID)

  // Passively capture GraphQL responses destined for X's own frontend.
  page.on('response', async (response) => {
    const u = response.url();
    if (!u.includes('/graphql/')) return;
    if (response.status() === 429 || response.status() === 503) {
      await limiter.onPressure();
      return;
    }
    if (!response.ok()) return;
    try {
      const json = await response.json();
      for (const raw of walkTweets(json)) {
        const t = normalizeTweet(raw);
        if (t.id && !collected.has(t.id)) {
          collected.set(t.id, t);
          onBatch?.([t]);
        }
      }
    } catch {
      /* non-JSON or partial response — ignore */
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await assertLoggedIn(page);
  await limiter.pause();

  let stagnantRounds = 0;
  for (let i = 0; i < maxScrolls && collected.size < limit; i++) {
    const before = collected.size;
    await page.mouse.wheel(0, 2500 + Math.random() * 1500);
    await limiter.pause();

    if (collected.size === before) {
      stagnantRounds += 1;
      if (stagnantRounds >= 4) break; // timeline exhausted
    } else {
      stagnantRounds = 0;
      limiter.resetBackoff();
    }
    if (!limiter.tick(0)) break;
  }

  await context.close();
  return [...collected.values()].slice(0, limit);
}

/** Convenience builders for the supported job types. */
export const jobs = {
  search: (query, tab = 'top') =>
    `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=${tab}`,
  timeline: (username) => `https://x.com/${encodeURIComponent(username.replace(/^@/, ''))}`,
  tweet: (idOrUrl) =>
    idOrUrl.startsWith('http') ? idOrUrl : `https://x.com/i/status/${encodeURIComponent(idOrUrl)}`,
  profile: (username) => `https://x.com/${encodeURIComponent(username.replace(/^@/, ''))}`,
};
