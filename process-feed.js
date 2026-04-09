#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, '.cache.json');

const API_BASE = 'https://readwise.io/api/v3';
const DELAY_MS = 3000; // 20 req/min = 1 per 3 seconds
const READ_MARKER = '📖 READ';

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const noCache = args.includes('--no-cache');
const archiveLater = args.includes('--archive-later');
const archiveSkipped = args.includes('--archive-skipped');
const pruneStale = args.includes('--prune-stale');
const staleDaysArg = args.find(a => a.startsWith('--stale-days='));
const staleDays = staleDaysArg ? parseInt(staleDaysArg.split('=')[1], 10) : 30;
const nukeLater = args.includes('--nuke-later');
const nukeDaysArg = args.find(a => a.startsWith('--nuke-days='));
const nukeDays = nukeDaysArg ? parseInt(nukeDaysArg.split('=')[1], 10) : 30;
const scoreShortlist = args.includes('--shortlist');

// ─── Shortlist scoring ────────────────────────────────────────────────────────

const SHORTLIST_THRESHOLD = 50;

// Trusted domains get a boost. Everything else is neutral.
const TRUSTED_DOMAINS = [
  // Quality tech / product
  'stratechery.com', 'paulgraham.com', 'waitbutwhy.com', 'every.to',
  'ben-evans.com', 'lenny.substack.com', 'lennysnewsletter.com', 'morningbrew.com',
  'hbr.org', 'firstround.com', 'a16z.com', 'sequoiacap.com',
  // General quality
  'nytimes.com', 'theatlantic.com', 'newyorker.com', 'noahpinion.substack.com',
  'bloomberg.com', 'wsj.com', 'economist.com', 'ft.com',
  // Tech news
  'techcrunch.com', 'theverge.com', 'wired.com', 'arstechnica.com',
  'simonwillison.net', 'macstories.net', 'daring fireball.net',
];

const SPAM_TITLE_SIGNALS = [
  'digest', 'weekly', 'vol.', 'issue', 'roundup',
  'links i loved', "what i'm reading", 'newsletter', 'edition',
  'this week in', 'weekend reads', 'morning links',
];

function scoreDoc(doc) {
  let score = 0;
  const breakdown = [];
  const title = (doc.title || '').toLowerCase();
  const category = (doc.category || 'article').toLowerCase();
  const summary = doc.summary || '';
  const url = doc.url || '';
  const readingProgress = doc.reading_progress || 0; // 0.0 to 1.0
  const wordCount = doc.word_count || 0;
  const savedAt = doc.saved_at || doc.created_at;

  // --- Category (0-30 pts) ---
  let catScore = 0;
  if (category === 'article') {
    catScore = 30;
  } else if (category === 'pdf') {
    catScore = 20;
  } else if (category === 'tweet') {
    // Thread detection: thread emoji OR substantial word count
    const isThread = title.includes('\uD83E\uDDF5') || title.includes('thread') || wordCount > 200;
    catScore = isThread ? 20 : 5;
  } else if (category === 'email') {
    catScore = 5;
  } else {
    catScore = 10; // video, podcast, etc.
  }
  score += catScore;
  breakdown.push(`category(${category}): +${catScore}`);

  // --- Summary quality (0-35 pts) ---
  let summaryScore = 0;

  if (summary.length > 100) {
    summaryScore += 15; // exists and substantive

    // Substantive content bonus (+5): long summary = Ghostreader had real material
    if (summary.length > 300) {
      summaryScore += 5;
      breakdown.push('summary_long: +5');
    }

    // Data signals (+5): suggests real research, not fluff
    const dataSignals = ['%', '\$', 'study', 'research', 'found that', 'according to',
      'survey', 'data shows', 'report', 'analysis'];
    if (dataSignals.some(s => summary.toLowerCase().includes(s))) {
      summaryScore += 5;
      breakdown.push('summary_data_signals: +5');
    }

    // Non-redundant summary (+5): Ghostreader extracted something beyond the title
    const titleWords = (doc.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const summaryLower = summary.toLowerCase();
    const overlapRatio = titleWords.length > 0
      ? titleWords.filter(w => summaryLower.includes(w)).length / titleWords.length
      : 1;
    if (overlapRatio < 0.4) {
      summaryScore += 5;
      breakdown.push('summary_non_redundant: +5');
    }

    // Direct quote (+5): signals Ghostreader found depth worth quoting
    if (/["\u201C\u201D].{20,}["\u201C\u201D]/.test(summary)) {
      summaryScore += 5;
      breakdown.push('summary_has_quote: +5');
    }

    // Summary spam signals (-10): newsletter/roundup disguised as article
    const summarySpam = ['this newsletter', "this week's edition", 'roundup of',
      'this issue', 'links this week', 'curated links'];
    if (summarySpam.some(s => summary.toLowerCase().includes(s))) {
      summaryScore -= 10;
      breakdown.push('summary_spam: -10');
    }
  }

  score += summaryScore;
  breakdown.push(`summary_base: +${Math.min(summaryScore, 15)}`);

  // --- Recency (0-20 pts) ---
  let recencyScore = 0;
  if (savedAt) {
    const daysSaved = Math.floor((Date.now() - new Date(savedAt)) / (1000 * 60 * 60 * 24));
    if (daysSaved <= 7) recencyScore = 20;
    else if (daysSaved <= 14) recencyScore = 15;
    else if (daysSaved <= 30) recencyScore = 10;
    else if (daysSaved <= 60) recencyScore = 5;
    score += recencyScore;
    breakdown.push(`recency(${daysSaved}d): +${recencyScore}`);
  }

  // --- Reading progress (0-15 pts) ---
  let progressScore = 0;
  const pct = readingProgress * 100;
  if (pct > 0 && pct < 90) {
    progressScore = 15; // started but unfinished
  } else if (pct === 0) {
    progressScore = 5;
  }
  // finished (>=90%) gets 0 — already done
  score += progressScore;
  breakdown.push(`progress(${Math.round(pct)}%): +${progressScore}`);

  // --- Spam title penalty (-30 pts) ---
  const isSpam = SPAM_TITLE_SIGNALS.some(s => title.includes(s));
  if (isSpam) {
    score -= 30;
    breakdown.push('spam_title: -30');
  }

  // --- Domain boost (+15 pts) ---
  let domainScore = 0;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    if (TRUSTED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
      domainScore = 15;
      score += domainScore;
      breakdown.push(`trusted_domain(${hostname}): +${domainScore}`);
    }
  } catch (_) {}

  return { score, breakdown, shortlist: score >= SHORTLIST_THRESHOLD };
}

async function addTag(docId, tag) {
  await apiRequest(`/update/${docId}/`, {
    method: 'PATCH',
    body: JSON.stringify({ tags: [tag] }),
  });
}

async function runShortlisting() {
  console.log('='.repeat(60));
  console.log('SHORTLIST SCORING (Later → tag: shortlist)');
  console.log(`Threshold: ${SHORTLIST_THRESHOLD} pts`);
  console.log('='.repeat(60));
  console.log('');

  const docs = await fetchDocuments('later');
  console.log(`Scoring ${docs.length} document(s) in Later...\n`);

  let tagged = 0;
  let skipped = 0;
  const topArticles = [];

  for (const doc of docs) {
    const title = doc.title || doc.url || `ID: ${doc.id}`;
    const { score, breakdown, shortlist } = scoreDoc(doc);

    if (shortlist) {
      log(`  [${score}] SHORTLIST: ${title}`);
      log(`    ${breakdown.join(' | ')}`);
      if (!dryRun) {
        await delay(DELAY_MS);
        await addTag(doc.id, 'shortlist');
      }
      tagged++;
      topArticles.push({ score, title });
    } else {
      log(`  [${score}] skip: ${title}`);
      skipped++;
    }
  }

  // Print top 10 by score regardless of verbose
  topArticles.sort((a, b) => b.score - a.score);
  console.log(`\nTop shortlisted articles:`);
  topArticles.slice(0, 10).forEach(a => console.log(`  [${a.score}] ${a.title}`));

  console.log('\n' + '='.repeat(60));
  console.log(`${dryRun ? '[DRY RUN] Would tag' : 'Tagged'}: ${tagged} | Skipped: ${skipped}`);
  console.log('='.repeat(60));
}
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const sinceArg = args.find(a => a.startsWith('--since='));
const sinceDays = sinceArg ? parseInt(sinceArg.split('=')[1], 10) : null;

// Cache functions
function loadCache() {
  if (noCache || !existsSync(CACHE_FILE)) {
    return { processed: {} };
  }
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return { processed: {} };
  }
}

function saveCache(cache) {
  if (dryRun || noCache) return;
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

const cache = loadCache();

// Get token from environment
const token = process.env.READWISE_TOKEN;
if (!token) {
  console.error('Error: READWISE_TOKEN environment variable is required');
  console.error('Get your token from: https://readwise.io/access_token');
  process.exit(1);
}

// Stats tracking
let stats = {
  total: 0,
  promoted: [],
  archivedNoRead: [],
  archivedNoSummary: [],
  skippedNoRead: [],
  skippedNoSummary: [],
  skippedCached: 0,
  skippedTooOld: 0
};

function log(message) {
  if (verbose) {
    console.log(message);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiRequest(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Token ${token}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After') || 60;
    console.warn(`Rate limited. Waiting ${retryAfter} seconds...`);
    await delay(retryAfter * 1000);
    return apiRequest(endpoint, options);
  }

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchDocuments(location, maxDocs = null) {
  const documents = [];
  let cursor = null;

  log(`Fetching documents from ${location}...`);

  do {
    const endpoint = cursor
      ? `/list/?location=${location}&pageCursor=${cursor}`
      : `/list/?location=${location}`;

    const data = await apiRequest(endpoint);

    // Filter to only get actual documents (not highlights/notes)
    const docs = (data.results || []).filter(doc =>
      doc.category !== 'highlight' && doc.category !== 'note'
    );

    documents.push(...docs);
    cursor = data.nextPageCursor;

    log(`  Fetched ${docs.length} documents (total: ${documents.length})`);

    // Stop early if we have enough documents
    if (maxDocs && documents.length >= maxDocs) {
      log(`  Stopping fetch (have ${documents.length}, need ${maxDocs})`);
      break;
    }

    if (cursor) {
      await delay(DELAY_MS);
    }
  } while (cursor);

  return documents;
}

async function updateDocumentLocation(documentId, location) {
  await apiRequest(`/update/${documentId}/`, {
    method: 'PATCH',
    body: JSON.stringify({ location })
  });
}

function hasReadMarker(doc) {
  const summary = doc.summary || '';
  const notes = doc.notes || '';
  return summary.includes(READ_MARKER) || notes.includes(READ_MARKER);
}

function hasSummary(doc) {
  const summary = doc.summary || '';
  return summary.length > 0;
}

function isWithinDays(doc, days) {
  if (!days) return true;
  const docDate = new Date(doc.created_at || doc.updated_at);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return docDate >= cutoff;
}

// Archive all items in Later
async function archiveAllLater() {
  console.log('='.repeat(60));
  console.log('ARCHIVING ALL LATER ITEMS');
  console.log('='.repeat(60));
  console.log('');

  const documents = await fetchDocuments('later');
  console.log(`\nFound ${documents.length} document(s) in Later\n`);

  if (documents.length === 0) {
    console.log('Nothing to archive.');
    return;
  }

  let archived = 0;
  for (const doc of documents) {
    const title = doc.title || doc.url || `ID: ${doc.id}`;
    log(`Archiving: ${title}`);

    if (dryRun) {
      log(`  [DRY RUN] Would archive`);
    } else {
      await delay(DELAY_MS);
      await updateDocumentLocation(doc.id, 'archive');
    }
    archived++;
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${dryRun ? '[DRY RUN] Would archive' : 'Archived'}: ${archived} document(s)`);
  console.log('='.repeat(60));
}

// Nuke Later: archive everything older than N days, no Ghostreader dependency
async function nukeLaterArticles(days) {
  console.log('='.repeat(60));
  console.log(`NUKING LATER — archiving everything older than ${days} days`);
  console.log('='.repeat(60));
  console.log('');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  console.log(`Cutoff: ${cutoff.toISOString().split('T')[0]} (anything saved before this gets archived)\n`);

  const docs = await fetchDocuments('later');
  console.log(`Found ${docs.length} document(s) in Later`);

  let nuked = 0;
  let kept = 0;
  let noDate = 0;

  for (const doc of docs) {
    const title = doc.title || doc.url || `ID: ${doc.id}`;
    // Use saved_at first (when it was added to Reader), then created_at
    const savedAt = doc.saved_at || doc.created_at;

    if (!savedAt) {
      console.log(`  No date: ${title}`);
      noDate++;
      continue;
    }

    const savedDate = new Date(savedAt);
    const daysSince = Math.floor((Date.now() - savedDate) / (1000 * 60 * 60 * 24));

    // Never nuke a shortlisted article — safety net even if order gets mixed up
    const tags = (doc.tags || []).map(t => (typeof t === 'string' ? t : t.name || '').toLowerCase());
    if (tags.includes('shortlist')) {
      if (verbose) console.log(`  Protecting (shortlist tag): ${title}`);
      kept++;
      continue;
    }

    if (savedDate < cutoff) {
      if (verbose) console.log(`  Archiving (${daysSince}d old): ${title}`);
      if (!dryRun) {
        await delay(DELAY_MS);
        await updateDocumentLocation(doc.id, 'archive');
      }
      nuked++;
    } else {
      if (verbose) console.log(`  Keeping (${daysSince}d old): ${title}`);
      kept++;
    }

    // Progress every 50 docs
    if ((nuked + kept) % 50 === 0) {
      console.log(`  Progress: ${nuked} archived, ${kept} kept so far...`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${dryRun ? '[DRY RUN] Would archive' : 'Archived'}: ${nuked} | Kept: ${kept} | No date: ${noDate}`);
  console.log('='.repeat(60));
}

// Process Feed documents
async function processFeed() {
  console.log('='.repeat(60));
  console.log('PROCESSING FEED');
  console.log('='.repeat(60));
  if (sinceDays) console.log(`Filtering to last ${sinceDays} days`);
  console.log('');

  let documents = await fetchDocuments('feed', limit);
  stats.total = documents.length;

  if (limit) {
    console.log(`\nFetched ${documents.length} document(s) from Feed (limited to ${limit})`);
    documents = documents.slice(0, limit);
  } else {
    console.log(`\nFound ${documents.length} document(s) in Feed`);
  }
  console.log('');

  if (documents.length === 0) {
    console.log('No documents to process.');
    return;
  }

  for (const doc of documents) {
    const title = doc.title || doc.url || `ID: ${doc.id}`;
    const docId = doc.id;

    // Skip if too old
    if (sinceDays && !isWithinDays(doc, sinceDays)) {
      log(`\nSkipping (too old): ${title}`);
      stats.skippedTooOld++;
      continue;
    }

    // Skip if already processed
    if (cache.processed[docId]) {
      log(`\nSkipping (cached): ${title}`);
      stats.skippedCached++;
      continue;
    }

    log(`\nProcessing: ${title}`);

    if (!hasSummary(doc)) {
      if (archiveSkipped) {
        log(`  No summary - archiving`);
        if (dryRun) {
          log(`  [DRY RUN] Would archive`);
        } else {
          await delay(DELAY_MS);
          await updateDocumentLocation(docId, 'archive');
        }
        stats.archivedNoSummary.push(title);
        cache.processed[docId] = { archived: true };
      } else {
        log(`  No summary yet (Ghostreader hasn't processed)`);
        stats.skippedNoSummary.push(title);
      }
      continue;
    }

    if (hasReadMarker(doc)) {
      log(`  Found "${READ_MARKER}" marker - promoting to Later`);
      if (dryRun) {
        log(`  [DRY RUN] Would move to Later`);
      } else {
        await delay(DELAY_MS);
        await updateDocumentLocation(docId, 'later');
      }
      stats.promoted.push(title);
      cache.processed[docId] = { promoted: true };
    } else {
      if (archiveSkipped) {
        log(`  No READ marker - archiving`);
        if (dryRun) {
          log(`  [DRY RUN] Would archive`);
        } else {
          await delay(DELAY_MS);
          await updateDocumentLocation(docId, 'archive');
        }
        stats.archivedNoRead.push(title);
        cache.processed[docId] = { archived: true };
      } else {
        log(`  Has summary but no READ marker`);
        stats.skippedNoRead.push(title);
        cache.processed[docId] = { promoted: false };
      }
    }
  }

  saveCache(cache);
  printSummary();
}

function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  if (dryRun) {
    console.log('(DRY RUN - no changes made)\n');
  }

  console.log(`Total documents checked: ${stats.total}`);

  console.log(`\nPromoted to Later (${stats.promoted.length}):`);
  if (stats.promoted.length > 0) {
    stats.promoted.forEach(t => console.log(`  - ${t}`));
  } else {
    console.log('  (none)');
  }

  if (stats.archivedNoRead.length > 0) {
    console.log(`\nArchived - no READ marker (${stats.archivedNoRead.length}):`);
    stats.archivedNoRead.slice(0, 10).forEach(t => console.log(`  - ${t}`));
    if (stats.archivedNoRead.length > 10) {
      console.log(`  ... and ${stats.archivedNoRead.length - 10} more`);
    }
  }

  if (stats.archivedNoSummary.length > 0) {
    console.log(`\nArchived - no summary (${stats.archivedNoSummary.length}):`);
    stats.archivedNoSummary.slice(0, 10).forEach(t => console.log(`  - ${t}`));
    if (stats.archivedNoSummary.length > 10) {
      console.log(`  ... and ${stats.archivedNoSummary.length - 10} more`);
    }
  }

  if (stats.skippedNoRead.length > 0) {
    console.log(`\nSkipped - has summary, no READ marker (${stats.skippedNoRead.length}):`);
    stats.skippedNoRead.forEach(t => console.log(`  - ${t}`));
  }

  if (stats.skippedNoSummary.length > 0) {
    console.log(`\nSkipped - no summary yet (${stats.skippedNoSummary.length}):`);
    stats.skippedNoSummary.forEach(t => console.log(`  - ${t}`));
  }

  if (stats.skippedTooOld > 0) {
    console.log(`\nSkipped - older than ${sinceDays} days: ${stats.skippedTooOld}`);
  }

  if (stats.skippedCached > 0) {
    console.log(`\nSkipped - already processed (cached): ${stats.skippedCached}`);
  }

  if (stats.pruned && stats.pruned.length > 0) {
    console.log(`\nPruned - stale (${stats.pruned.length}):`); 
    stats.pruned.slice(0, 10).forEach(t => console.log(`  - ${t}`));
    if (stats.pruned.length > 10) console.log(`  ... and ${stats.pruned.length - 10} more`);
  }

  console.log('\n' + '='.repeat(60));
}

// Prune stale articles from Feed and Later
async function pruneStaleArticles(days) {
  console.log('='.repeat(60));
  console.log(`PRUNING STALE ARTICLES (not opened in ${days}+ days)`);
  console.log('='.repeat(60));
  console.log('');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  log(`Cutoff date: ${cutoff.toISOString().split('T')[0]}`);

  let pruned = [];
  let skipped = [];

  for (const location of ['feed', 'later']) {
    const docs = await fetchDocuments(location);
    log(`\nChecking ${docs.length} document(s) in ${location}...`);

    for (const doc of docs) {
      const title = doc.title || doc.url || `ID: ${doc.id}`;

      // Determine the last interaction date.
      // last_opened_at is most accurate; fall back to created_at.
      const lastTouched = doc.last_opened_at || doc.created_at;
      if (!lastTouched) {
        log(`  Skipping (no date): ${title}`);
        skipped.push(title);
        continue;
      }

      const lastDate = new Date(lastTouched);
      const daysSince = Math.floor((Date.now() - lastDate) / (1000 * 60 * 60 * 24));

      if (lastDate < cutoff) {
        log(`  Stale (${daysSince}d): ${title}`);
        if (dryRun) {
          log(`    [DRY RUN] Would archive`);
        } else {
          await delay(DELAY_MS);
          await updateDocumentLocation(doc.id, 'archive');
        }
        pruned.push(`${title} (${daysSince}d, ${location})`);
      } else {
        log(`  Fresh (${daysSince}d): ${title}`);
      }
    }
  }

  console.log(`\n${dryRun ? '[DRY RUN] Would prune' : 'Pruned'}: ${pruned.length} stale article(s)`);
  if (skipped.length > 0) console.log(`Skipped (no date): ${skipped.length}`);

  return pruned;
}

async function main() {
  console.log('Reader Feed Processor');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Verbose: ${verbose ? 'ON' : 'OFF'}`);
  if (archiveSkipped) console.log('Archive skipped: ON');
  if (limit) console.log(`Limit: ${limit} document(s)`);
  if (sinceDays) console.log(`Since: ${sinceDays} days`);
  console.log('');

  if (pruneStale) console.log(`Prune stale: ON (>${staleDays} days)`);
  if (nukeLater) console.log(`Nuke Later: ON (archive everything >${nukeDays} days old)`);
  if (scoreShortlist) console.log(`Shortlist: ON (threshold: ${SHORTLIST_THRESHOLD} pts)`);

  try {
    // Shortlist FIRST so good articles are tagged before any nuking
    if (scoreShortlist) {
      await runShortlisting();
      console.log('');
    }

    // Nuke AFTER shortlisting — shortlisted articles are protected inside nukeLaterArticles()
    if (nukeLater) {
      await nukeLaterArticles(nukeDays);
      console.log('');
    }

    if (pruneStale) {
      const pruned = await pruneStaleArticles(staleDays);
      stats.pruned = pruned;
      console.log('');
    }

    if (archiveLater) {
      await archiveAllLater();
      console.log('');
    }

    if (!pruneStale || archiveLater || true) {
      await processFeed();
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
