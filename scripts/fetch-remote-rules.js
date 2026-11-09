// Fetches all "Remote rules" hostlist sources with plain HTTP requests.
//
// adblock.mahakala.is is behind Cloudflare, which returns a challenge page
// (or an outright 403) for requests that look bot-like. A normal browser
// User-Agent + Accept headers is enough to get through from a residential/
// office IP - confirmed directly against the live site. GitHub Actions'
// own runner IPs get a 403 regardless of headers (Cloudflare scores IP
// reputation, not just headers, and datacenter CI ranges are commonly
// flagged), but this pipeline's primary run is from a home network, where
// this works fine. If this ever runs from a flagged IP (e.g. someone
// manually triggers the GitHub Actions fallback), this source degrades to
// contributing 0 rules rather than failing the whole build.
const fs = require('fs');

const SOURCES = [
  { url: 'https://sysctl.org/cameleon/hosts', out: 'hostlists/cameleon_hosts.txt' },
  {
    url: 'https://s3.amazonaws.com/lists.disconnect.me/simple_tracking.txt',
    out: 'hostlists/lists.disconnect.me_simple_tracking.txt',
  },
  // The bare root URL serves an HTML landing page to browser User-Agents
  // (it only serves the list to apps), so point at the list path directly.
  // /hosts is the 10 MB edition (~326K domains); larger editions exist at
  // /hosts-25mb, /hosts-50mb and /hosts-final, but the router (2GB RAM) has
  // OOMed on oversized lists before.
  { url: 'https://adblock.mahakala.is/hosts', out: 'hostlists/adblock.mahakala.is.txt' },
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
  // Case-insensitive: servers commonly send lowercase "<!doctype html>",
  // which a case-sensitive check let through into the compiled list.
  const head = text.trim().slice(0, 1000).toLowerCase();
  return (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.includes('<head>') ||
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
