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

function googleNewsRSS(query) {
  const params = new URLSearchParams({ q: query, hl: 'en-IN', gl: 'IN', ceid: 'IN:en' });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

const FEEDS = [
  { url: 'https://inc42.com/feed/', source: 'Inc42' },
  { url: 'https://inc42.com/buzz/feed/', source: 'Inc42 Buzz' },
  { url: 'https://yourstory.com/feed', source: 'YourStory' },
  // WordPress sites publish a feed at /feed/ by default - this is a reasonable guess for
  // Entrackr, not a confirmed URL (unlike the three above, which are documented/known-working).
  // If this 403s or 404s consistently in the Action logs, remove this line.
  { url: 'https://entrackr.com/feed/', source: 'Entrackr' },
  // Google News search-as-RSS - no auth, aggregates across hundreds of publishers, not just
  // one site's own posts. This is the main lever for more coverage. It's an undocumented,
  // unofficial interface (Google could change its format without notice), so if these three
  // ever stop returning results, that's the first thing to check - the query format itself,
  // not a bug in the parsing logic below.
  { url: googleNewsRSS('(raises OR secures OR bags) (funding OR crore OR million) India startup'), source: 'Google News · Funding' },
  { url: googleNewsRSS('"Global Capability Centre" OR "Global Capability Center" OR GCC India office'), source: 'Google News · GCC' },
  { url: googleNewsRSS('("opens new office" OR "new office in" OR "expands to") India'), source: 'Google News · Expansion' },
  { url: googleNewsRSS('("looking for office space" OR "scouting for office" OR "lease renewal" OR "relocating to") India company'), source: 'Google News · Relocation' },
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

/* ===== Mid-segment fit (40-300 people) =====
 * The big integrated players (Smartworks, Awfis, JLL and similar) chase large accounts -
 * mega-rounds, big GCCs - because small deals aren't worth their time. That gap is
 * deliberately the target here: companies in a size band nobody big is chasing yet.
 * Two signals feed this, in priority order:
 *   1. An explicit headcount mentioned in the text ("team of 120", "80 employees") -
 *      the strongest signal when present, checked directly against the 40-300 band.
 *   2. Funding round stage as a fallback proxy when no headcount is mentioned - Seed
 *      through Series B companies are far more likely to still be in this size band
 *      than Series C+ companies, which have usually scaled well past it. */
const MID_SEGMENT_MIN = 40, MID_SEGMENT_MAX = 300;
const HEADCOUNT_PATTERN = /\b(\d{2,4})\+?[\s-]*(?:(?:more|new|additional)\s+)?(?:employees?|people|staff|workforce|team members|hires?|headcount)\b|\bteam of\s*(\d{2,4})\b/i;
const EARLY_ROUNDS = ['Pre-Seed', 'Seed', 'Pre-Series A', 'Series A', 'Series B'];
const LATE_ROUNDS = ['Series C', 'Series D', 'Series E'];

function extractHeadcount(text) {
  const m = text.match(HEADCOUNT_PATTERN);
  if (!m) return null;
  const n = parseInt((m[1] || m[2]).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/** Returns one of: 'fit' | 'mismatch' | 'likely-fit' | 'likely-mismatch' | 'unknown' */
function assessMidSegmentFit(text, round) {
  const headcount = extractHeadcount(text);
  if (headcount !== null) {
    return (headcount >= MID_SEGMENT_MIN && headcount <= MID_SEGMENT_MAX) ? 'fit' : 'mismatch';
  }
  if (EARLY_ROUNDS.includes(round)) return 'likely-fit';
  if (LATE_ROUNDS.includes(round)) return 'likely-mismatch';
  return 'unknown';
}

// Keyword sets used to classify each headline into a signal type.
// Tune these over time - they're intentionally simple (regex/includes) so
// they're easy to extend without touching the fetch/parse logic.
const SIGNAL_RULES = [
  { type: 'GCC Setup', pattern: /\b(GCC|global capability cent(?:er|re)|captive cent(?:er|re))\b/i },
  // Checked before Expansion Announcement - this is the rare, weaker signal of a company
  // saying out loud that it's actively hunting for space (often tied to a lease coming up),
  // as distinct from an announcement of growth/new-market entry.
  { type: 'Relocation Intent', pattern: /\b(looking for (?:(?:a|an|the|new)\s+)*office|scouting (?:for\s+)?(?:(?:a|an|the|new)\s+)*office|exploring (?:(?:a|an|the|new)\s+)*office (?:space|options)|lease renewal|renew(?:ing|al)? (?:its|their|the) lease|relocat(?:e|ing|ion) (?:to|plans)|searching for (?:(?:a|an|the|new)\s+)*(?:office|workspace)|on the hunt for (?:office|workspace))\b/i },
  { type: 'Expansion Announcement', pattern: /\b(opens? (?:a |its )?(?:new )?office|new office in|expand(?:s|ing)? (?:to|into|in)|foray(?:s)? into)\b/i },
  { type: 'Funding Round', pattern: /\b(raises?|raised|secures?|bags?|closes?)\b.{0,40}\b(crore|cr|million|mn|\$|series [a-e]|seed round|funding)\b/i },
];

// Sector: headlines from these feeds very often lead with the sector as a descriptor
// ("Fintech startup X...", "Climatetech startup Y...") - checked in this order, first
// match wins, so more specific terms are listed before the generic ones they'd otherwise
// also match (e.g. "insurtech" before the generic "tech" would ever be considered).
const SECTOR_RULES = [
  { sector: 'Fintech', pattern: /\b(fintech|neobank|insurtech|lending|payments?|wealth management|wealthtech|BNPL|buy now pay later|crypto(?:currency)?|digital banking|NBFC)\b/i },
  { sector: 'Healthtech', pattern: /\b(healthtech|health[- ]?tech|healthcare startup|healthcare platform|pharma(?:ceutical)?|biotech|medtech|elder care|mental health|diagnostics|hospital(?:s)? chain|fertility)\b/i },
  { sector: 'Edtech', pattern: /\b(edtech|ed[- ]?tech|e-?learning|upskilling|skilling platform)\b/i },
  { sector: 'Climatetech', pattern: /\b(climatetech|cleantech|clean energy|renewable energy|sustainab\w*|carbon (?:credit|capture)|EV charging|electric vehicle|battery tech|solar)\b/i },
  { sector: 'Agritech', pattern: /\b(agri[- ]?tech|agriculture startup|dairy tech|dairy technology|farm(?:ing)? tech)\b/i },
  { sector: 'Proptech', pattern: /\bproptech\b/i },
  { sector: 'Mobility / EV', pattern: /\b(mobility startup|EV startup|electric (?:scooter|bike|vehicle) startup|ride[- ]hailing|micromobility)\b/i },
  { sector: 'Deeptech / AI', pattern: /\b(deeptech|deep[- ]?tech|artificial intelligence|generative AI|\bAI\b|machine learning|robotics|spacetech|space[- ]tech)\b/i },
  { sector: 'Cybersecurity', pattern: /\b(cybersecurity|cyber security|infosec|data security)\b/i },
  { sector: 'Logistics', pattern: /\b(logistics|supply chain|warehousing|last[- ]mile|fulfil?lment|quick commerce|q[- ]commerce)\b/i },
  { sector: 'Travel', pattern: /\b(travel[- ]?tech|travel startup|hospitality startup|booking platform)\b/i },
  { sector: 'D2C / Consumer', pattern: /\b(D2C|direct[- ]to[- ]consumer|consumer brand|FMCG|beauty brand|fashion brand|foodtech|food[- ]tech)\b/i },
  { sector: 'E-commerce', pattern: /\b(e-?commerce|marketplace|C2C)\b/i },
  { sector: 'SaaS / Enterprise', pattern: /\b(SaaS|enterprise software|B2B software|HRtech|HR[- ]tech|legaltech|legal[- ]tech)\b/i },
  { sector: 'Gaming / Media', pattern: /\b(gaming|media startup|content platform|streaming)\b/i },
];

function extractSector(text) {
  for (const rule of SECTOR_RULES) {
    if (rule.pattern.test(text)) return rule.sector;
  }
  return '';
}

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

// Google News titles come as "Headline Text - Publisher Name" - strip the suffix so it
// doesn't interfere with company/amount/round extraction further down the pipeline.
function stripGoogleNewsSuffix(title) {
  return title.replace(/\s+-\s+[A-Za-z0-9][A-Za-z0-9.&' ]{1,40}$/, '').trim();
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, { headers: { 'User-Agent': 'SS-x-TF-Lead-Scanner/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const isGoogleNews = feed.source.startsWith('Google News');
    return parseRSSItems(xml).map((item) => ({
      ...item,
      title: isGoogleNews ? stripGoogleNewsSuffix(item.title) : item.title,
      source: feed.source,
    }));
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
    const round = extractRound(combinedText);
    fresh.push({
      id: `scan-${Buffer.from(item.link).toString('base64').slice(0, 16)}`,
      company: guessCompany(item.title),
      signalType,
      city: guessCity(item),
      amount: extractAmount(combinedText),
      round,
      sector: extractSector(combinedText),
      headcount: extractHeadcount(combinedText),
      fit: assessMidSegmentFit(combinedText, round),
      headline: item.title,
      link: item.link,
      source: item.source,
      pubDate: item.pubDate,
      scannedAt: new Date().toISOString(),
    });
  }

  // Surface the best mid-segment fits first, so the first thing you see each scan is
  // the stuff worth actually looking at - not sorted by publish time.
  const FIT_ORDER = { fit: 0, 'likely-fit': 1, unknown: 2, 'likely-mismatch': 3, mismatch: 4 };
  fresh.sort((a, b) => FIT_ORDER[a.fit] - FIT_ORDER[b.fit]);

  // Keep a rolling window: new suggestions in front, old ones fall off after 60 days
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const keptOld = (previous.suggestions || []).filter((s) => new Date(s.scannedAt).getTime() > cutoff);

  // Backfill: suggestions carried over from before a classification field existed (fit, sector,
  // amount, round, headcount) would otherwise show blank forever - they're deduped by link, so
  // they're never re-fetched from the live feed and never get re-classified on their own. Re-run
  // classification against whatever text is still available (just the headline, at this point -
  // less than the original title+description, so backfilled values can be less precise than a
  // fresh scan, but far better than a permanently empty column).
  const backfilled = keptOld.map((s) => {
    if (s.fit !== undefined && s.sector !== undefined) return s; // already fully classified, leave as-is
    const text = s.headline || '';
    const round = s.round || extractRound(text);
    return {
      ...s,
      amount: s.amount || extractAmount(text),
      round,
      sector: s.sector !== undefined ? s.sector : extractSector(text),
      headcount: s.headcount !== undefined ? s.headcount : extractHeadcount(text),
      fit: s.fit || assessMidSegmentFit(text, round),
    };
  });

  const suggestions = [...fresh, ...backfilled];

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

module.exports = { parseRSSItems, classifySignal, guessCity, guessCompany, extractAmount, extractRound, extractHeadcount, extractSector, assessMidSegmentFit, stripGoogleNewsSuffix, googleNewsRSS, SIGNAL_RULES, SECTOR_RULES, CITY_LIST, FEEDS };
