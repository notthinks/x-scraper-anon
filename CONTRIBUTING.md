# Contributing to x-scraper-no-api

Thanks for helping keep no-API X scraping alive. This project survives on maintenance — X changes its frontend constantly, and every parser improvement matters.

## Ground rules

1. **Compliance is a feature.** PRs that add credential handling, CAPTCHA bypass, proxy rotation, account pooling, or rate-limit evasion will be closed. We deliberately do not build those.
2. **Public data only.** No support for protected accounts, DMs, or anything behind extra access controls.
3. **Stable schema.** The normalized tweet schema in `src/scraper.js` is a public contract. Add fields; never rename or remove them without a major version bump.

## Development setup

```bash
git clone https://github.com/JoinArtisanVent/x-scraper-no-api.git
cd x-scraper-no-api
npm install
npx playwright install chromium
node src/cli.js login        # one-time manual login
node src/cli.js search "open source" --limit 10
```

## Architecture map

| File | Responsibility |
|---|---|
| `src/cli.js` | Commander CLI, argument parsing, progress display |
| `src/session.js` | Persistent Playwright profile, manual login flow |
| `src/scraper.js` | GraphQL response interception, tweet normalization, scroll loop |
| `src/ratelimit.js` | Human-like pacing, hard caps, backoff on pressure |
| `src/output.js` | JSON / JSONL / CSV / Markdown writers |
| `skills/` | Agent Skill manifest (OpenClaw / Hermes compatible) |

## What to work on

- **Parser robustness**: X rotates GraphQL operation names and response shapes. The `walkTweets` deep-walk is intentionally shape-agnostic — keep it that way.
- **New job types**: lists, communities, trends — same pattern: build a URL, scroll, capture.
- **Tests**: fixture-based tests for `normalizeTweet` against captured GraphQL JSON (scrub personal data first).
- **Docs**: README translations, more examples, agent integration guides.

## Pull request checklist

- [ ] `node src/cli.js --help` runs clean
- [ ] No new dependencies without discussion in an issue first
- [ ] Schema changes documented in README
- [ ] No credential/cookie handling code, ever
