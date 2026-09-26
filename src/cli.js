#!/usr/bin/env node
// cli.js — xscraper command-line interface.

import { Command } from 'commander';
import { login } from './session.js';
import { scrape, jobs } from './scraper.js';
import { write } from './output.js';

const program = new Command();

program
  .name('xscraper')
  .description(
    'Free, self-hosted X (Twitter) scraper — no API key. Uses your own browser session.\nNot affiliated with X Corp. Public data only. Use responsibly.'
  )
  .version('1.0.0');

function addCommon(cmd) {
  return cmd
    .option('-l, --limit <n>', 'max items to collect', '50')
    .option('-f, --format <fmt>', 'output format: json | jsonl | csv | md', 'json')
    .option('-o, --out <file>', 'write to file instead of stdout')
    .option('--profile-dir <dir>', 'custom browser profile directory')
    .option('--headed', 'show the browser window while scraping');
}

async function run(cmdOpts, url, title) {
  let seen = 0;
  const tweets = await scrape({
    url,
    limit: parseInt(cmdOpts.limit, 10),
    profileDir: cmdOpts.profileDir,
    headless: !cmdOpts.headed,
    onBatch: (batch) => {
      seen += batch.length;
      process.stderr.write(`\r  collected ${seen}…`);
    },
  });
  process.stderr.write('\n');
  write(tweets, { format: cmdOpts.format, out: cmdOpts.out, title });
}

program
  .command('login')
  .description('Open a browser and log into X manually (one-time setup)')
  .option('--profile-dir <dir>', 'custom browser profile directory')
  .action(async (opts) => {
    await login({ profileDir: opts.profileDir });
  });

addCommon(
  program
    .command('search')
    .description('Search posts on X (supports advanced operators: from:, since:, min_faves:, …)')
    .argument('<query>', 'search query, e.g. "from:nasa since:2026-01-01"')
    .option('--latest', 'use the Latest tab instead of Top')
).action(async (query, opts) => {
  await run(opts, jobs.search(query, opts.latest ? 'live' : 'top'), `Search: ${query}`);
});

addCommon(
  program
    .command('timeline')
    .description("Collect posts from a user's public timeline")
    .argument('<username>', 'X handle, with or without @')
).action(async (username, opts) => {
  await run(opts, jobs.timeline(username), `Timeline: @${username.replace(/^@/, '')}`);
});

addCommon(
  program
    .command('tweet')
    .description('Fetch a single post and its public replies by ID or URL')
    .argument('<idOrUrl>', 'status ID or full https://x.com/…/status/… URL')
).action(async (idOrUrl, opts) => {
  await run(opts, jobs.tweet(idOrUrl), `Post: ${idOrUrl}`);
});

program.parseAsync(process.argv).catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
