// Post-processes the raw merged output of hostlist-compiler (run with
// transformations: [] - just fetch + concatenate, no processing) and
// replicates what the compiler's own "RemoveComments" + "Compress" +
// "Deduplicate" transformations do, but efficiently.
//
// Rule parsing/classification (is this a /etc/hosts line? a bare domain? an
// adblock "||domain^" rule?) is delegated straight to @adguard/
// hostlist-compiler's own rule.js utilities, so it stays byte-for-byte
// consistent with however that package defines those formats - no
// duplicated regexes to drift out of sync.
//
// What's reimplemented is only the redundant-subdomain elimination from its
// compress.js (discard "||sub.example.com^" when "||example.com^" - or any
// parent domain - already exists). The original does this with
// `filtered.splice(i, 1)` inside a loop over the full (multi-million-line)
// array. Array.splice is O(n) per call, so that pass is O(n^2) overall -
// confirmed by benchmarking it: compressing ~772K lines took ~48s, but
// ~3.4M lines (4.4x more) didn't finish in 10 minutes. This script does the
// equivalent check with a Set for membership tests and a single filter()
// pass instead, which is O(n * avg-label-depth) - effectively linear.
//
// Also normalizes "domain.com #Company - Category" leftovers - a shape
// hostlist-compiler itself doesn't recognize as any known rule format, so
// it used to pass these through untouched.
const fs = require('fs');
const readline = require('readline');
const ruleUtils = require('@adguard/hostlist-compiler/src/rule');

const INPUT = process.argv[2] || 'dns-blacklist.txt';
const OUTPUT = process.argv[3] || 'dns-blacklist.txt';
const TMP = `${OUTPUT}.tmp`;

// Mirrors compress.js's extractHostnames(): "a.b.c" -> ["a.b.c", "b.c", "c"]
function parentChain(hostname) {
  const parts = hostname.split('.');
  const chain = [];
  for (let i = 0; i < parts.length; i += 1) {
    chain.push(parts.slice(i).join('.'));
  }
  return chain;
}

async function main() {
  const input = readline.createInterface({
    input: fs.createReadStream(INPUT),
    crlfDelay: Infinity,
  });

  const stats = {
    total: 0,
    droppedBang: 0,
    droppedHash: 0,
    etcHostsExpanded: 0,
    justDomain: 0,
    convertedInlineComment: 0,
    alreadyAdblock: 0,
    passedThrough: 0,
  };

  // entries preserves original encounter order; each item is either
  // { host: 'example.com' } (compressible, subject to redundancy check)
  // or { raw: 'some literal rule text' } (kept as-is, never discarded).
  const entries = [];
  const seenHosts = new Set();
  const seenRaw = new Set();
  const allHosts = new Set(); // full hostname universe, for the redundancy pass

  function addHost(hostname) {
    const key = hostname.toLowerCase();
    allHosts.add(key);
    if (!seenHosts.has(key)) {
      seenHosts.add(key);
      entries.push({ host: key });
    }
  }

  function addRaw(text) {
    if (!seenRaw.has(text)) {
      seenRaw.add(text);
      entries.push({ raw: text });
    }
  }

  for await (const line of input) {
    stats.total++;

    if (line.trim().length === 0) {
      stats.droppedBlank = (stats.droppedBlank || 0) + 1;
      continue;
    }
    if (line.startsWith('!')) {
      stats.droppedBang++;
      continue;
    }
    if (line.trimStart().startsWith('#')) {
      stats.droppedHash++;
      continue;
    }

    // Already-well-formed "||domain^" (with no other modifiers).
    const adblockProps = ruleUtils.loadAdblockRuleProperties(line);
    if (adblockProps.hostname && !adblockProps.whitelist && !adblockProps.options) {
      stats.alreadyAdblock++;
      addHost(adblockProps.hostname);
      continue;
    }

    // "0.0.0.0 domain.com [domain2 ...] [#comment]" style lines.
    if (ruleUtils.isEtcHostsRule(line)) {
      const { hostnames } = ruleUtils.loadEtcHostsRuleProperties(line);
      if (hostnames.length > 0) {
        stats.etcHostsExpanded++;
        for (const h of hostnames) addHost(h);
        continue;
      }
    }

    // Bare "domain.com" lines.
    if (ruleUtils.isJustDomain(line)) {
      stats.justDomain++;
      addHost(line);
      continue;
    }

    // "domain.com #Company - Category" - not recognized by any of the
    // above (the trailing comment breaks isJustDomain's whole-string
    // match, and it doesn't start with an IP so isEtcHostsRule rejects it
    // too), so hostlist-compiler leaves these untouched. Clean them up.
    const hashIdx = line.indexOf(' #');
    if (hashIdx !== -1) {
      const domain = line.slice(0, hashIdx).trim();
      if (ruleUtils.isJustDomain(domain)) {
        stats.convertedInlineComment++;
        addHost(domain);
        continue;
      }
    }

    stats.passedThrough++;
    addRaw(line);
  }

  // Redundancy pass: discard a host if any of its parent domains (not
  // itself) is also present - same rule as compress.js, computed via a Set
  // instead of repeated array splicing.
  const discard = new Set();
  for (const key of seenHosts) {
    const chain = parentChain(key);
    for (let i = 1; i < chain.length; i += 1) {
      if (allHosts.has(chain[i])) {
        discard.add(key);
        break;
      }
    }
  }

  const output = fs.createWriteStream(TMP);
  let outputLines = 0;
  let redundantSubdomains = 0;
  for (const entry of entries) {
    if (entry.host !== undefined) {
      if (discard.has(entry.host)) {
        redundantSubdomains++;
        continue;
      }
      output.write(`||${entry.host}^\n`);
    } else {
      output.write(`${entry.raw}\n`);
    }
    outputLines++;
  }

  await new Promise((resolve) => output.end(resolve));
  fs.renameSync(TMP, OUTPUT);

  console.log('[normalize-blacklist] input lines:', stats.total);
  console.log('[normalize-blacklist] dropped "!" comment lines:', stats.droppedBang);
  console.log('[normalize-blacklist] dropped "#" comment/separator lines:', stats.droppedHash);
  console.log('[normalize-blacklist] already "||domain^" lines:', stats.alreadyAdblock);
  console.log('[normalize-blacklist] /etc/hosts-style lines expanded:', stats.etcHostsExpanded);
  console.log('[normalize-blacklist] bare "just domain" lines:', stats.justDomain);
  console.log('[normalize-blacklist] converted "domain #comment" lines:', stats.convertedInlineComment);
  console.log('[normalize-blacklist] passed through unrecognized lines:', stats.passedThrough);
  console.log('[normalize-blacklist] discarded as redundant subdomains:', redundantSubdomains);
  console.log('[normalize-blacklist] output lines:', outputLines);
}

main().catch((err) => {
  console.error('[normalize-blacklist] failed:', err);
  process.exit(1);
});
