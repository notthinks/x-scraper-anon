<div align="center">

# 🕊️ x-scraper-no-api

### The free, self-hosted X (Twitter) scraper. No API key. No credits. No middleman.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 18](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/powered%20by-Playwright-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev)
[![Agent Skill](https://img.shields.io/badge/AI%20agents-OpenClaw%20%C2%B7%20Hermes-blueviolet)](skills/x-scraper-no-api/SKILL.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Your browser. Your session. Your data. Running entirely on your machine.**

[Quickstart](#-quickstart-macos) · [Why no-API](#-why-no-api) · [For AI agents](#-built-for-ai-agents) · [For developers](#-for-developers) · [FAQ](#-faq)

</div>

---

The X API costs **$100–$5,000+/month**. Hosted scraper services bill you **per tweet** and hold your data on their servers. Meanwhile, your own browser already shows you everything you need — for free.

**x-scraper-no-api** turns that browser into a clean data pipeline. You log in **once, manually**, in a real browser window. After that, one command exports search results, timelines, and threads as **LLM-ready JSON, CSV, or Markdown** — straight to your disk, never through a third party.

## ✨ Features

- 🔑 **Zero API keys** — no developer account, no app approval, no billing page
- 🖐️ **Manual login, once** — your password and 2FA never touch this tool; the browser session persists like any normal browser
- 🧠 **LLM-ready output** — JSON, JSONL, CSV, or token-friendly Markdown built for AI agent context windows
- 🤖 **Agent-native** — ships a ready-to-install [Skill](skills/x-scraper-no-api/SKILL.md) for **OpenClaw**, **Hermes**, and any CLI-capable agent
- 🎯 **Full X search syntax** — `from:`, `since:`, `until:`, `min_faves:`, `filter:media`, `lang:` and every advanced operator
- 🧱 **Resilient parsing** — reads the structured GraphQL data X sends its own frontend instead of scraping fragile HTML class names
- 🐢 **Polite by design** — human-like pacing, hard item caps, automatic backoff when X signals pressure
- 🔒 **Private** — everything runs locally; nothing is proxied, relayed, or uploaded anywhere

## ⚖️ Why no-API?

| | Official X API | Hosted scraper APIs | **x-scraper-no-api** |
|---|---|---|---|
| Cost | $100–$42,000/mo | Per-tweet credits | **$0, forever** |
| Signup friction | Developer account + approval | Account + card | **None** |
| Your query data | X's servers | Third-party servers | **Your machine only** |
| Rate limits | Plan-capped | Credit-capped | **Politeness-capped** |
| Vendor lock-in | Yes | Yes | **No — MIT licensed** |
| AI agent skill | DIY | Sometimes | **Built in** |

## 🚀 Quickstart (macOS)

Three steps. Two minutes.

**1. Install Xcode Command Line Tools** (needed for native builds):

```bash
xcode-select --install
```

**2. Install Node.js** — grab the official installer or nvm from [nodejs.org/en/download](https://nodejs.org/en/download) (Node 18 or newer).

**3. Install the scraper:**

```bash
mkdir -p 'xscraper' && cd 'xscraper' && npm install github:JoinArtisanVent/x-scraper-no-api
```

Then finish setup and log in manually (one time):

```bash
npx playwright install chromium
npx xscraper login        # a browser opens — sign into X yourself
```

That's it. Your session lives in `~/.xscraper/` and every future run is headless.

## 📖 Usage

```bash
# Search — full X advanced-search syntax
xscraper search "from:openai since:2026-01-01 min_faves:500" --limit 50 --format md

# The Latest tab instead of Top
xscraper search "ai agents" --latest --limit 25

# A public timeline
xscraper timeline @nasa --limit 100 --format csv -o nasa.csv

# One post + its public replies
xscraper tweet https://x.com/nasa/status/1846987139428634858 --format json
```

| Flag | What it does |
|---|---|
| `--limit <n>` | Max items (default 50, hard cap 200 — by design) |
| `--format` | `json` · `jsonl` · `csv` · `md` (Markdown = best for LLMs) |
| `-o <file>` | Write to a file instead of stdout |
| `--headed` | Watch the browser work (debugging) |

<details>
<summary><b>Sample record (JSON)</b></summary>

```json
{
  "id": "1846987139428634858",
  "url": "https://x.com/nasa/status/1846987139428634858",
  "created_at": "Wed Oct 16 12:34:56 +0000 2026",
  "text": "Liftoff! …",
  "lang": "en",
  "author": { "username": "nasa", "name": "NASA", "verified": true, "followers": 80000000 },
  "metrics": { "replies": 1200, "reposts": 4800, "likes": 32000, "views": 1500000 },
  "hashtags": ["EuropaClipper"],
  "media": [{ "type": "photo", "url": "https://pbs.twimg.com/media/…" }],
  "scraped_at": "2026-09-26T10:00:00.000Z"
}
```

</details>

## 🤖 Built for AI agents

This repo ships an agent **Skill** at [`skills/x-scraper-no-api/SKILL.md`](skills/x-scraper-no-api/SKILL.md) — a portable manifest that teaches agents how (and how *not*) to use the tool.

- **OpenClaw / Hermes**: point your agent at the `skills/` directory, or copy `SKILL.md` into your agent's skills folder.
- **Any LLM script**: shell out to the CLI and feed stdout into your prompt — see [`examples/agent-workflow.md`](examples/agent-workflow.md).

```python
import subprocess
ctx = subprocess.run(
    ["xscraper", "search", "local-first software", "--limit", "50", "--format", "md"],
    capture_output=True, text=True, timeout=600,
).stdout  # ready for your prompt
```

The Skill enforces a safety contract: public data only, small limits, no credential handling, scraped content treated as untrusted input.

## 🛠️ For developers

Want to hack on it? Welcome — this project lives or dies by community maintenance.

**Architecture** (deliberately small — 5 files):

```
src/
├── cli.js        # Commander CLI
├── session.js    # Persistent Playwright profile + manual login
├── scraper.js    # GraphQL response interception + normalization
├── ratelimit.js  # Human pacing, hard caps, backoff
└── output.js     # JSON / JSONL / CSV / Markdown writers
skills/x-scraper-no-api/SKILL.md   # Agent Skill manifest
```

**How it works:** we never call X's internal endpoints directly. A real Chromium instance loads x.com exactly as it does for a human; we passively capture the GraphQL JSON X streams to its own frontend and normalize it into a stable schema. When X redesigns its markup, we don't break — we never read the markup.

**Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md). The most valuable PRs are parser-robustness fixes, new job types (lists, trends), and fixture tests for the normalizer. PRs adding CAPTCHA bypass, proxy rotation, or credential handling will be declined — compliance is a feature here.

**Roadmap**

- [ ] List and community job types
- [ ] Fixture-based test suite for the normalizer
- [ ] Scheduled/resumable runs with checkpoints
- [ ] MCP server wrapper
- [ ] Linux/Windows install one-liners

## 🛡️ Responsible use & legal

This tool is built to stay on the right side of the line:

- ✅ **Public posts only** — protected accounts, DMs, and restricted content are not supported and never will be
- ✅ **You authenticate yourself** — manual login in your own browser; the tool never sees credentials, cookies, or 2FA codes
- ✅ **No circumvention** — no CAPTCHA solving, no proxy rotation, no account pooling, no rate-limit evasion
- ✅ **Paced like a human** — conservative delays, small caps, automatic cooldowns
- 📋 Results may contain personal data — have a lawful purpose, minimize storage, honor deletion requests (GDPR & friends apply)
- ⚖️ You are responsible for complying with [X's Terms of Service](https://x.com/en/tos) and applicable law in your jurisdiction

> **Disclaimer:** This is an independent, community-maintained open-source project. It is **not affiliated with, endorsed by, or sponsored by X Corp.** "Twitter" and "X" are trademarks of X Corp. No X Corp code, assets, or proprietary material is included in this repository.

## ❓ FAQ

**Do I need an X account?**
Yes — X removed anonymous browsing years ago. You log in manually once, in your own browser. Use an account you're comfortable browsing with.

**Will my account get banned?**
The tool paces itself conservatively and caps every run. No tool can guarantee zero risk — keep limits modest and don't run it around the clock.

**Why 200 items max?**
Deliberately. This is a research and agent-context tool, not a bulk-harvesting machine. Two focused 50-item searches beat one giant trawl.

**It returned fewer results than my limit!**
The timeline was exhausted — that's normal, not a bug.

**Windows/Linux?**
Everything except the Quickstart wording is cross-platform — install Node 18+, then the same `npm install github:…` line works everywhere.

**Why does login open a real browser?**
Because that's the point. Manual login means no credential handling, no automation-detection games, and a session X itself issued.

---

<div align="center">

**If this saved you an API bill, a ⭐ helps others find it.**

MIT © [JoinArtisanVent](https://github.com/JoinArtisanVent) · Not affiliated with X Corp.

</div>
