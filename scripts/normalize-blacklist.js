// Cleans up dns-blacklist.txt after hostlist-compiler runs:
//   - drops "!" header/metadata comment lines
//   - drops "#" comment lines and decorative separators (e.g. "#=====...",
//     "#*****...#", stray hosts-file comments like "# GoodDomains[i++] = ...")
//   - normalizes "domain.com #Company - Category" style entries (source:
//     disconnect.me-style lists) into proper "||domain.com^" rules
//   - leaves already-well-formed "||domain.com^" rules untouched
//   - anything else that doesn't match a known pattern is passed through
//     unchanged, so this never silently deletes content nobody asked about
//   - deduplicates the final output: normalizing "domain #comment" lines
//     into "||domain^" form can make them exact duplicates of rules that
//     already existed elsewhere (hostlist-compiler's own Deduplicate pass
//     ran before this normalization, so it never saw them as equal)
const fs = require('fs');
const readline = require('readline');

const FILE = 'dns-blacklist.txt';
const TMP = 'dns-blacklist.txt.tmp';

async function main() {
  const input = readline.createInterface({
    input: fs.createReadStream(FILE),
    crlfDelay: Infinity,
  });
  const output = fs.createWriteStream(TMP);
  const seen = new Set();

  const stats = {
    total: 0,
    keptAsIs: 0,
    droppedBang: 0,
    droppedHash: 0,
    convertedInlineComment: 0,
    passedThrough: 0,
    droppedDuplicate: 0,
  };

  function writeUnique(line) {
    if (seen.has(line)) {
      stats.droppedDuplicate++;
      return;
    }
    seen.add(line);
    output.write(line + '\n');
  }

  for await (const line of input) {
    stats.total++;

    if (line.startsWith('!')) {
      stats.droppedBang++;
      continue;
    }

    if (line.trimStart().startsWith('#')) {
      stats.droppedHash++;
      continue;
    }

    if (/^\|\|.+\^$/.test(line)) {
      stats.keptAsIs++;
      writeUnique(line);
      continue;
    }

    const hashIdx = line.indexOf(' #');
    if (hashIdx !== -1) {
      const domain = line.slice(0, hashIdx).trim();
      if (domain.length > 0) {
        stats.convertedInlineComment++;
        writeUnique(`||${domain}^`);
      } else {
        stats.droppedHash++;
      }
      continue;
    }

    stats.passedThrough++;
    writeUnique(line);
  }

  await new Promise((resolve) => output.end(resolve));
  fs.renameSync(TMP, FILE);

  console.log('[normalize-blacklist] input lines:', stats.total);
  console.log('[normalize-blacklist] dropped "!" comment lines:', stats.droppedBang);
  console.log('[normalize-blacklist] dropped "#" comment/separator lines:', stats.droppedHash);
  console.log('[normalize-blacklist] converted "domain #comment" lines:', stats.convertedInlineComment);
  console.log('[normalize-blacklist] already well-formed "||domain^" lines:', stats.keptAsIs);
  console.log('[normalize-blacklist] passed through unrecognized lines:', stats.passedThrough);
  console.log('[normalize-blacklist] dropped duplicate lines:', stats.droppedDuplicate);
  console.log('[normalize-blacklist] output lines:', seen.size);
}

main().catch((err) => {
  console.error('[normalize-blacklist] failed:', err);
  process.exit(1);
});
