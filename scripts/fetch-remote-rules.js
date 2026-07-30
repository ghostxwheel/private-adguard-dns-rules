// Fetches all "Remote rules" hostlist sources with plain HTTP requests.
//
// adblock.mahakala.is serves a Cloudflare "Just a moment..." challenge page
// to bare `curl` (no headers), which looked like it needed a real browser to
// solve - but it doesn't: the challenge is triggered purely by the request
// looking bot-like (missing User-Agent/Accept headers), not by any actual
// JS/compute check. A normal browser User-Agent + Accept headers gets a
// real 200 response with the full list, confirmed directly against the
// live site. Same for sysctl.org, which a headless-browser fetch mishandled
// (page.goto() treated its response as a file download) but plain HTTP
// never had any problem with.
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

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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

async function fetchOne({ url, out }) {
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

(async () => {
  await Promise.all(SOURCES.map(fetchOne));
})();
