// Fetches all "Remote rules" hostlist sources.
//
// Three of the four are fetched with a plain HTTP request (fast, no browser
// needed). adblock.mahakala.is needs a real headless browser: it's behind
// Cloudflare, and while a plain request with a normal browser User-Agent is
// enough to get through from a residential/office IP, GitHub Actions' own
// runner IPs get an outright HTTP 403 - Cloudflare is scoring the request's
// TLS/HTTP fingerprint and IP reputation, not just headers, and datacenter
// CI ranges are commonly flagged. A full headless Chromium fetch (real TLS
// handshake, executes the challenge JS) gets through from the same runner
// IP where a bare fetch() does not - confirmed directly in production.
const fs = require('fs');
const { chromium } = require('playwright');

const PLAIN_SOURCES = [
  { url: 'https://sysctl.org/cameleon/hosts', out: 'hostlists/cameleon_hosts.txt' },
  {
    url: 'https://s3.amazonaws.com/lists.disconnect.me/simple_tracking.txt',
    out: 'hostlists/lists.disconnect.me_simple_tracking.txt',
  },
  {
    url: 'https://phishing.army/download/phishing_army_blocklist_extended.txt',
    out: 'hostlists/phishing_army_blocklist_extended.txt',
  },
];

const MAHAKALA = { url: 'https://adblock.mahakala.is', out: 'hostlists/adblock.mahakala.is.txt' };

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

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

async function fetchPlain({ url, out }) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    if (!res.ok) {
      console.error(`[fetch-remote-rules] ${url}: HTTP ${res.status}. Writing empty file.`);
      fs.writeFileSync(out, '');
      return;
    }

    const text = await res.text();
    if (looksBlocked(text)) {
      console.error(
        `[fetch-remote-rules] ${url}: got ${text.length} chars, looks blocked/invalid. Writing empty file.`,
      );
      fs.writeFileSync(out, '');
      return;
    }

    fs.writeFileSync(out, text);
    console.log(`[fetch-remote-rules] ${url}: wrote ${text.split('\n').length} lines to ${out}`);
  } catch (err) {
    console.error(`[fetch-remote-rules] ${url}: fetch failed (${err.message}). Writing empty file.`);
    fs.writeFileSync(out, '');
  }
}

async function fetchMahakala({ url, out }) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: USER_AGENT, acceptDownloads: true });
  const page = await context.newPage();

  // The response can come back as a page or as a native browser file
  // download depending on Cloudflare's mood - handle both.
  let download = null;
  page.once('download', (d) => {
    download = d;
  });

  try {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (err) {
      if (!/Download is starting/.test(err.message)) throw err;
    }

    // The 'download' event can arrive slightly after goto()'s promise
    // settles, so give it a moment to land before checking the flag.
    await page.waitForTimeout(1500);

    let text;
    if (download) {
      const path = await download.path();
      text = fs.readFileSync(path, 'utf8');
    } else {
      // Gives Cloudflare's JS challenge time to resolve and auto-redirect.
      await page.waitForTimeout(6500);
      text = await page.evaluate(() => document.body.innerText);
    }

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
    await context.close();
    await browser.close();
  }
}

(async () => {
  await Promise.all([...PLAIN_SOURCES.map(fetchPlain), fetchMahakala(MAHAKALA)]);
})();
