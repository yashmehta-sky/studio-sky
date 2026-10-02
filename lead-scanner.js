#!/usr/bin/env node
/**
 * SS x TF Lead Scanner
 * ---------------------
 * Runs daily (via GitHub Actions - see .github/workflows/lead-scanner.yml).
 * Pulls public RSS feeds from India startup-funding news sources, filters for
 * items that look like real estate / office-space signals (funding rounds,
 * GCC setups, expansion announcements), and writes the result to
 * leads-feed.json, which the app reads and shows as "Suggested Leads" on
 * the Lead Pipeline page.
 *
 * This script needs real internet access (RSS feeds, live sites) - it will
 * NOT run inside the app itself or in a sandboxed environment. It only
 * works as a scheduled job with outbound network access, e.g. GitHub Actions.
 */

const FEEDS = [
  { url: 'https://inc42.com/feed/', source: 'Inc42' },
  { url: 'https://inc42.com/buzz/feed/', source: 'Inc42 Buzz' },
  { url: 'https://yourstory.com/feed', source: 'YourStory' },
  // WordPress sites publish a feed at /feed/ by default - this is a reasonable guess for
  // Entrackr, not a confirmed URL (unlike the three above, which are documented/known-working).
  // If this 403s or 404s consistently in the Action logs, remove this line.
  { url: 'https://entrackr.com/feed/', source: 'Entrackr' },
];

// Funding amount: "Rs 150 Cr", "₹150 crore", "$12 Mn", "$12 million", "$1.2 Bn"
const AMOUNT_PATTERN = /(?:₹|rs\.?\s?)\s?([\d,]+(?:\.\d+)?)\s?(cr|crore)\b|\$\s?([\d,]+(?:\.\d+)?)\s?(mn|million|bn|billion|k)?\b/i;

// Funding round / stage
const ROUND_PATTERN = /\b(pre-?seed|seed|bridge|series\s?[a-e](?:\+[0-9])?|pre-?series\s?[a-e]|debt(?: round)?|growth(?: round)?)\b/i;

function extractAmount(text) {
  const m = text.match(AMOUNT_PATTERN);
  if (!m) return '';
  if (m[1]) return `₹${m[1]} ${m[2].toLowerCase() === 'cr' ? 'Cr' : 'Crore'}`;
  if (m[3]) {
    const unit = (m[4] || '').toLowerCase();
    const label = unit.startsWith('b') ? 'Bn' : unit === 'k' ? 'K' : 'Mn';
    return `$${m[3]} ${label}`;
  }
  return '';
}

function extractRound(text) {
  const m = text.match(ROUND_PATTERN);
  if (!m) return '';
  // Normalise casing: "series a" -> "Series A", "pre-seed" -> "Pre-Seed"
  return m[1].replace(/\b\w/g, (c) => c.toUpperCase());
}

// Keyword sets used to classify each headline into a signal type.
// Tune these over time - they're intentionally simple (regex/includes) so
// they're easy to extend without touching the fetch/parse logic.
const SIGNAL_RULES = [
  { type: 'GCC Setup', pattern: /\b(GCC|global capability cent(?:er|re)|captive cent(?:er|re))\b/i },
  { type: 'Expansion Announcement', pattern: /\b(opens? (?:a |its )?(?:new )?office|new office in|expand(?:s|ing)? (?:to|into|in)|foray(?:s)? into)\b/i },
  { type: 'Funding Round', pattern: /\b(raises?|raised|secures?|bags?|closes?)\b.{0,40}\b(crore|cr|million|mn|\$|series [a-e]|seed round|funding)\b/i },
];

const CITY_LIST = [
  'Bengaluru', 'Bangalore', 'Mumbai', 'Delhi', 'NCR', 'Gurugram', 'Gurgaon',
  'Noida', 'Pune', 'Hyderabad', 'Chennai', 'Kolkata', 'Ahmedabad', 'Ranchi',
  'Jaipur', 'Lucknow', 'Chandigarh', 'Kochi', 'Indore',
];

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

/** Minimal RSS 2.0 parser - no dependencies, works on the standard <item> shape
 *  these feeds use. If a feed ever changes format this is the first place to look. */
function parseRSSItems(xmlText) {
  const items = [];
  const itemBlocks = xmlText.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    items.push({
      title: tag(block, 'title'),
      link: tag(block, 'link'),
      pubDate: tag(block, 'pubDate'),
      description: tag(block, 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
  }
  return items;
}

function classifySignal(item) {
  const text = `${item.title} ${item.description}`;
  for (const rule of SIGNAL_RULES) {
    if (rule.pattern.test(text)) return rule.type;
  }
  return null;
}

function guessCity(item) {
  // Prefer a city named in the headline itself (most likely the actual signal location)
  // before falling back to the body text, which may mention an unrelated city
  // (e.g. "...expanding beyond its Mumbai headquarters" in a story about a Gurugram office).
  for (const city of CITY_LIST) {
    if (new RegExp(`\\b${city}\\b`, 'i').test(item.title)) return city;
  }
  for (const city of CITY_LIST) {
    if (new RegExp(`\\b${city}\\b`, 'i').test(item.description)) return city;
  }
  return '';
}

/** Headlines are reliably "<Company> raises/secures/opens ..." in these feeds -
 *  take the text before the first signal verb as a best-effort company guess.
 *  This is a heuristic, not a guarantee - always shown to a human to confirm. */
function guessCompany(title) {
  const m = title.match(/^([A-Z][A-Za-z0-9&.'\- ]{1,40}?)\s+(?:raises?|raised|secures?|bags?|closes?|opens?|expands?|forays?)/i);
  return m ? m[1].trim() : title.split(/[:,-]/)[0].trim().slice(0, 60);
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, { headers: { 'User-Agent': 'SS-x-TF-Lead-Scanner/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRSSItems(xml).map((item) => ({ ...item, source: feed.source }));
  } catch (err) {
    console.error(`Failed to fetch ${feed.url}: ${err.message}`);
    return [];
  }
}

async function main() {
  const fs = await import('fs');
  const path = await import('path');
  const outPath = path.resolve(process.cwd(), 'leads-feed.json');

  let previous = { seenLinks: [], suggestions: [] };
  if (fs.existsSync(outPath)) {
    try { previous = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (e) { /* start fresh */ }
  }
  const seen = new Set(previous.seenLinks || []);

  const allItems = (await Promise.all(FEEDS.map(fetchFeed))).flat();

  const fresh = [];
  for (const item of allItems) {
    if (!item.link || seen.has(item.link)) continue;
    const signalType = classifySignal(item);
    if (!signalType) continue;
    seen.add(item.link);
    const combinedText = `${item.title} ${item.description}`;
    fresh.push({
      id: `scan-${Buffer.from(item.link).toString('base64').slice(0, 16)}`,
      company: guessCompany(item.title),
      signalType,
      city: guessCity(item),
      amount: extractAmount(combinedText),
      round: extractRound(combinedText),
      headline: item.title,
      link: item.link,
      source: item.source,
      pubDate: item.pubDate,
      scannedAt: new Date().toISOString(),
    });
  }

  // Keep a rolling window: new suggestions in front, old ones fall off after 60 days
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const keptOld = (previous.suggestions || []).filter((s) => new Date(s.scannedAt).getTime() > cutoff);
  const suggestions = [...fresh, ...keptOld];

  const output = {
    lastRun: new Date().toISOString(),
    seenLinks: Array.from(seen).slice(-2000), // cap growth of the dedupe list
    suggestions,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Scan complete: ${fresh.length} new signal(s) found, ${suggestions.length} total in the rolling window.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

module.exports = { parseRSSItems, classifySignal, guessCity, guessCompany, extractAmount, extractRound, SIGNAL_RULES, CITY_LIST };
