// session.js — Browser session management.
//
// Design principle: the USER logs in manually, once, in a real browser window.
// This tool never sees, stores, or transmits credentials. It only reuses the
// session cookies that X itself set in the local browser profile — the same
// way your browser keeps you logged in between restarts.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.xscraper', 'browser-profile');

export function profileDir(customDir) {
  const dir = customDir || process.env.XSCRAPER_PROFILE_DIR || DEFAULT_PROFILE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Open a visible browser so the user can log into X manually.
 * The session persists in the profile directory for future runs.
 */
export async function login({ profileDir: customDir, timeoutMs = 300_000 } = {}) {
  const dir = profileDir(customDir);
  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────────┐');
  console.log('  │  A browser window is open. Log into X manually.         │');
  console.log('  │  This tool never sees your password or 2FA codes.       │');
  console.log('  │  The window closes automatically once you are logged in.│');
  console.log('  └─────────────────────────────────────────────────────────┘');
  console.log('');

  // Wait until the user lands on the home timeline (login complete).
  await page.waitForURL(/x\.com\/home/, { timeout: timeoutMs });
  // Give X a moment to settle cookies into the profile.
  await page.waitForTimeout(3000);
  await context.close();
  console.log(`Session saved to ${dir}`);
  console.log('You can now run headless commands, e.g.:  xscraper search "open source" --limit 50');
}

/**
 * Launch a headless persistent context reusing the saved session.
 * Throws a friendly error if the user has not logged in yet.
 */
export async function openSession({ profileDir: customDir, headless = true } = {}) {
  const dir = profileDir(customDir);
  const context = await chromium.launchPersistentContext(dir, {
    headless,
    viewport: { width: 1280, height: 2000 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  return context;
}

/** Verify the saved session is still authenticated. */
export async function assertLoggedIn(page) {
  const state = await page.evaluate(() => ({
    hasLoginForm: !!document.querySelector('input[name="text"]'),
    hasTimeline: !!document.querySelector('[data-testid="primaryColumn"]'),
  }));
  if (state.hasLoginForm && !state.hasTimeline) {
    throw new Error(
      'Not logged in. Run `xscraper login` first — a browser window will open so you can sign in manually.'
    );
  }
}
