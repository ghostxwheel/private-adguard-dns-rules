// Fetches all "Remote rules" hostlist sources that the workflow used to grab
// with plain curl. Moved to a headless browser for all of them (not just
// adblock.mahakala.is) so every source goes through one consistent path,
// and so any source that starts sitting behind Cloudflare/JS-challenge
// protection in the future degrades gracefully instead of silently
// committing an HTML challenge page as a "rule".
const { chromium } = require('playwright');
const fs = require('fs');

const SOURCES = [
  { url: 'https://sysctl.org/cameleon/hosts', out: 'hostlists/cameleon_hosts.txt' },
  {
    url: 'https://s3.amazonaws.com/lists.disconnect.me/simple_tracking.txt',
    out: 'hostlists/lists.disconnect.me_simple_tracking.txt',
  },
  { url: 'https://adblock.mahakala.is', out: 'hostlists/adblock.mahakala.is.txt' },
  {
    url: 'https://phishing.army/download/phishing_army_blocklist_extended.txt',
    out: 'hostlists/phishing_army_blocklist_extended.txt',
  },
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function looksBlocked(text) {
  if (!text || text.length < 100) return true;
  const head = text.trim().slice(0, 200);
  return (
    head.startsWith('<!DOCTYPE') ||
    head.startsWith('<html') ||
    text.includes('Just a moment') ||
    text.includes('Enable JavaScript and cookies to continue')
  );
}

async function fetchOne(browser, { url, out }) {
  const page = await browser.newPage({ userAgent: USER_AGENT });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    // Gives Cloudflare-style JS challenges (e.g. mahakala.is) time to resolve
    // and auto-redirect; harmless no-op wait for plain-text sources.
    await page.waitForTimeout(8000);
    const text = await page.evaluate(() => document.body.innerText);

    if (looksBlocked(text)) {
      console.error(
        `[fetch-remote-rules] ${url}: got ${text ? text.length : 0} chars, looks blocked/invalid. Writing empty file.`,
      );
      fs.writeFileSync(out, '');
      return;
    }

    fs.writeFileSync(out, text);
    console.log(`[fetch-remote-rules] ${url}: wrote ${text.split('\n').length} lines to ${out}`);
  } catch (err) {
    console.error(`[fetch-remote-rules] ${url}: fetch failed (${err.message}). Writing empty file.`);
    fs.writeFileSync(out, '');
  } finally {
    await page.close();
  }
}

(async () => {
  const browser = await chromium.launch();
  for (const source of SOURCES) {
    await fetchOne(browser, source);
  }
  await browser.close();
})();
