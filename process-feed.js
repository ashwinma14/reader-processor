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

// ─── Shortlist config ─────────────────────────────────────────────────────────

const SHORTLIST_THRESHOLD = 50;
const SHORTLIST_CAP = 20;
const SHORTLIST_DECAY_DAYS = 10;    // untouched for this many days → decay penalty
const SHORTLIST_DECAY_PENALTY = 15; // points deducted for stale items
const VIDEO_PDF_EXTRA = 10;         // videos/PDFs must beat threshold + this

// ─── Taxonomy ────────────────────────────────────────────────────────────────

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
  'simonwillison.net', 'macstories.net', 'daringfireball.net',
];

const SPAM_TITLE_SIGNALS = [
  'digest', 'weekly', 'vol.', 'issue', 'roundup',
  'links i loved', "what i'm reading", 'newsletter', 'edition',
  'this week in', 'weekend reads', 'morning links',
];

// Reference/how-to content → Library tag, not Shortlist
const LIBRARY_SIGNALS = [
  'how to ', 'guide to', 'framework for', 'template for', 'cheat sheet',
  'reference guide', 'step by step', 'tutorial', 'handbook', 'playbook',
  'getting started', 'complete guide', 'beginners guide', 'crash course',
];

// Topic clusters for diversity enforcement
const TOPIC_CLUSTERS = {
  ai_ml: ['artificial intelligence', ' ai ', 'llm', 'machine learning', 'gpt',
    'claude', 'openai', 'anthropic', 'neural network', 'foundation model',
    'ai agent', 'chatgpt', 'gemini', 'language model'],
  product: ['product manager', 'product management', 'product strategy', 'roadmap',
    'user research', 'product market fit', 'prioritization', 'sprint', 'backlog'],
  startup_vc: ['startup', 'venture capital', 'fundraising', 'seed round', 'series a',
    'series b', 'founder', ' vc ', 'valuation', 'exit strategy', 'ipo'],
  org_leadership: ['org design', 'leadership', 'management', 'company culture',
    'team building', 'hiring', 'performance review', 'executive', 'ceo', 'strategy'],
  writing_ideas: ['writing', 'essay', 'mental model', 'decision making', 'cognitive bias',
    'reasoning', 'thinking clearly', 'philosophy'],
};

function detectCluster(doc) {
  const text = ((doc.title || '') + ' ' + (doc.summary || '')).toLowerCase();
  for (const [cluster, keywords] of Object.entries(TOPIC_CLUSTERS)) {
    if (keywords.some(kw => text.includes(kw))) return cluster;
  }
  return 'other';
}

function isLibraryContent(doc) {
  const text = ((doc.title || '') + ' ' + (doc.summary || '')).toLowerCase();
  return LIBRARY_SIGNALS.some(s => text.includes(s));
}

function isHeavyFormat(doc) {
  const cat = (doc.category || '').toLowerCase();
  return cat === 'video' || cat === 'pdf' || cat === 'podcast';
}

function getDomain(doc) {
  try {
    return new URL(doc.url || '').hostname.replace(/^www\./, '');
  } catch (_) {
    return 'unknown';
  }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scoreDoc(doc) {
  let score = 0;
  const breakdown = [];
  const title = (doc.title || '').toLowerCase();
  const category = (doc.category || 'article').toLowerCase();
  const summary = doc.summary || '';
  const url = doc.url || '';
  const readingProgress = doc.reading_progress || 0;
  const wordCount = doc.word_count || 0;
  const savedAt = doc.saved_at || doc.created_at;

  // --- Category (0-30 pts) ---
  let catScore = 0;
  if (category === 'article') catScore = 30;
  else if (category === 'pdf') catScore = 20;
  else if (category === 'tweet') {
    const isThread = title.includes('🧵') || title.includes('thread') || wordCount > 200;
    catScore = isThread ? 20 : 5;
  } else if (category === 'email') catScore = 5;
  else catScore = 10; // video, podcast, etc.
  score += catScore;
  breakdown.push(`category(${category}): +${catScore}`);

  // --- Summary quality (0-35 pts) ---
  let summaryScore = 0;
  if (summary.length > 100) {
    summaryScore += 15;
    if (summary.length > 300) { summaryScore += 5; breakdown.push('summary_long: +5'); }
    const dataSignals = ['%', '$', 'study', 'research', 'found that', 'according to',
      'survey', 'data shows', 'report', 'analysis'];
    if (dataSignals.some(s => summary.toLowerCase().includes(s))) {
      summaryScore += 5;
      breakdown.push('summary_data_signals: +5');
    }
    const titleWords = (doc.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const summaryLower = summary.toLowerCase();
    const overlapRatio = titleWords.length > 0
      ? titleWords.filter(w => summaryLower.includes(w)).length / titleWords.length
      : 1;
    if (overlapRatio < 0.4) { summaryScore += 5; breakdown.push('summary_non_redundant: +5'); }
    if (/[""\u201C\u201D].{20,}[""\u201C\u201D]/.test(summary)) {
      summaryScore += 5;
      breakdown.push('summary_has_quote: +5');
    }
    const summarySpam = ['this newsletter', "this week's edition", 'roundup of',
      'this issue', 'links this week', 'curated links'];
    if (summarySpam.some(s => summary.toLowerCase().includes(s))) {
      summaryScore -= 10;
      breakdown.push('summary_spam: -10');
    }
  }

  // Writing fuel signal (+5): suggests an angle worth thinking/blogging about
  const writingFuelSignals = ['argues that', 'counterintuitive', 'most people',
    'the real reason', 'unpopular opinion', 'this changes', 'what nobody',
    'the problem with', 'case for', 'case against', 'why most', 'overlooked'];
  if (writingFuelSignals.some(s => (summary + title).toLowerCase().includes(s))) {
    summaryScore += 5;
    breakdown.push('writing_fuel: +5');
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
  if (pct > 0 && pct < 90) progressScore = 15;
  else if (pct === 0) progressScore = 5;
  score += progressScore;
  breakdown.push(`progress(${Math.round(pct)}%): +${progressScore}`);

  // --- Spam title penalty (-30 pts) ---
  if (SPAM_TITLE_SIGNALS.some(s => title.includes(s))) {
    score -= 30;
    breakdown.push('spam_title: -30');
  }

  // --- Domain boost (+15 pts) ---
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    if (TRUSTED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
      score += 15;
      breakdown.push(`trusted_domain(${hostname}): +15`);
    }
  } catch (_) {}

  return { score, breakdown, shortlist: score >= SHORTLIST_THRESHOLD };
}

// ─── Notes ───────────────────────────────────────────────────────────────────

function humanizeShortlistReason(score, breakdown, decayApplied) {
  const reasons = [];

  const category = breakdown.find((b) => b.startsWith('category('));
  if (category?.includes('article')) reasons.push('it\'s a full article');
  else if (category?.includes('email')) reasons.push('it looks like a high-signal newsletter');
  else if (category?.includes('tweet')) reasons.push('it looks like a worthwhile thread or tweet');
  else if (category?.includes('video')) reasons.push('it\'s a video that scored unusually well');
  else if (category?.includes('pdf')) reasons.push('it\'s a document worth your time');

  const recency = breakdown.find((b) => b.startsWith('recency('));
  if (recency) {
    const m = recency.match(/recency\((\d+)d\)/);
    if (m) {
      const days = Number(m[1]);
      if (days <= 3) reasons.push('it\'s very recent');
      else if (days <= 7) reasons.push('it\'s still fresh');
      else reasons.push('it\'s older but still worth surfacing');
    }
  }

  if (breakdown.some((b) => b.startsWith('trusted_domain('))) {
    reasons.push('it came from a source worth paying attention to');
  }

  if (breakdown.some((b) => b.includes('writing_fuel'))) {
    reasons.push('the angle seems worth thinking about');
  } else if (breakdown.some((b) => b.startsWith('summary_base'))) {
    reasons.push('the summary suggests there\'s real substance here');
  }

  const cleanReasons = [...new Set(reasons)].slice(0, 3);
  const why = cleanReasons.length
    ? cleanReasons.join(', ')
    : 'it scored well across freshness, substance, and source quality';

  const suffix = decayApplied ? ' (survived decay — still worth opening)' : '';
  return `Worth reading soon: ${why}. Score: ${score}.${suffix}`;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function moveToShortlist(docId, score, breakdown, decayApplied = false) {
  const note = humanizeShortlistReason(score, breakdown, decayApplied);
  await apiRequest(`/update/${docId}/`, {
    method: 'PATCH',
    body: JSON.stringify({ location: 'shortlist', notes: note }),
  });
}

async function demoteFromShortlist(docId) {
  await apiRequest(`/update/${docId}/`, {
    method: 'PATCH',
    body: JSON.stringify({ location: 'later' }),
  });
}

async function addLibraryTag(doc) {
  // Use PATCH /update/ with the doc's id — no risk of re-saving archived items to Later
  if (!doc.id) return;
  await apiRequest(`/update/${doc.id}/`, {
    method: 'PATCH',
    body: JSON.stringify({ tags: { library: { name: 'library' } } }),
  });
}

// ─── Shortlisting v2 ─────────────────────────────────────────────────────────

async function runShortlisting() {
  console.log('='.repeat(60));
  console.log('SHORTLIST v2');
  console.log(`Cap: ${SHORTLIST_CAP} | Threshold: ${SHORTLIST_THRESHOLD} | Decay: ${SHORTLIST_DECAY_DAYS}d → -${SHORTLIST_DECAY_PENALTY}pts`);
  console.log('='.repeat(60));
  console.log('');

  // 1. Fetch current Shortlist items
  console.log('Fetching current Shortlist...');
  const currentShortlist = await fetchDocuments('shortlist');
  console.log(`  ${currentShortlist.length} items currently in Shortlist`);

  // Score existing Shortlist items; apply decay if untouched
  const currentScored = currentShortlist.map(doc => {
    const { score, breakdown } = scoreDoc(doc);
    const lastTouched = doc.last_opened_at || doc.updated_at || doc.saved_at;
    let effectiveScore = score;
    let decayApplied = false;
    if (lastTouched) {
      const daysSince = Math.floor((Date.now() - new Date(lastTouched)) / (1000 * 60 * 60 * 24));
      if (daysSince >= SHORTLIST_DECAY_DAYS) {
        effectiveScore -= SHORTLIST_DECAY_PENALTY;
        decayApplied = true;
        log(`  [DECAY -${SHORTLIST_DECAY_PENALTY}] ${doc.title || doc.url} (${daysSince}d untouched)`);
      }
    }
    return { doc, score, effectiveScore, breakdown, inShortlist: true, decayApplied };
  });

  // 2. Fetch Later docs
  console.log('\nFetching Later...');
  const laterDocs = await fetchDocuments('later');
  console.log(`  ${laterDocs.length} items in Later`);

  // 3. Filter library candidates and score the rest
  const libraryCandidates = [];
  const laterCandidates = [];

  for (const doc of laterDocs) {
    if (isLibraryContent(doc)) {
      libraryCandidates.push(doc);
      continue;
    }
    const { score, breakdown } = scoreDoc(doc);
    const threshold = isHeavyFormat(doc)
      ? SHORTLIST_THRESHOLD + VIDEO_PDF_EXTRA
      : SHORTLIST_THRESHOLD;
    if (score >= threshold) {
      laterCandidates.push({ doc, score, effectiveScore: score, breakdown, inShortlist: false, decayApplied: false });
    }
  }

  console.log(`\n  Library candidates (will be tagged, not shortlisted): ${libraryCandidates.length}`);
  console.log(`  Later candidates above threshold: ${laterCandidates.length}`);

  // 4. Tag library content
  let libTagged = 0;
  for (const doc of libraryCandidates) {
    log(`  [LIBRARY] ${doc.title || doc.url}`);
    if (!dryRun) {
      try {
        await delay(DELAY_MS);
        await addLibraryTag(doc);
        libTagged++;
      } catch (e) {
        log(`    library tag failed: ${e.message}`);
      }
    } else {
      libTagged++;
    }
  }
  console.log(`  Library tagged: ${libTagged}`);

  // 5. Diversity filter on Later candidates (max 2 per domain, max 2 per cluster)
  const domainCounts = {};
  const clusterCounts = {};
  const diversified = [];

  laterCandidates.sort((a, b) => b.effectiveScore - a.effectiveScore);

  for (const c of laterCandidates) {
    const domain = getDomain(c.doc);
    const cluster = detectCluster(c.doc);

    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    clusterCounts[cluster] = (clusterCounts[cluster] || 0) + 1;

    if (domainCounts[domain] > 2) {
      log(`  [DIVERSITY skip domain=${domain}] ${c.doc.title}`);
      continue;
    }
    if (cluster !== 'other' && clusterCounts[cluster] > 2) {
      log(`  [DIVERSITY skip cluster=${cluster}] ${c.doc.title}`);
      continue;
    }

    diversified.push(c);
  }

  console.log(`  After diversity filter: ${diversified.length} Later candidates`);

  // 6. Merge and rank — pick top SHORTLIST_CAP
  const allCandidates = [...currentScored, ...diversified];
  allCandidates.sort((a, b) => b.effectiveScore - a.effectiveScore);

  const winners = allCandidates.slice(0, SHORTLIST_CAP);
  const winnerIds = new Set(winners.map(c => c.doc.id));

  // 7. Demote Shortlist items that didn't survive
  const toDemote = currentScored.filter(c => !winnerIds.has(c.doc.id));
  // 8. Promote new items from Later
  const toPromote = diversified.filter(c => winnerIds.has(c.doc.id));

  console.log(`\nShortlist changes:`);
  console.log(`  Keeping in Shortlist: ${currentScored.length - toDemote.length}`);
  console.log(`  Demoting back to Later: ${toDemote.length}`);
  console.log(`  Promoting from Later: ${toPromote.length}`);
  console.log(`  Final Shortlist size: ${winners.length}`);

  // Execute demotions
  let demoted = 0;
  for (const c of toDemote) {
    log(`  [DEMOTE] ${c.doc.title || c.doc.url} (score: ${c.effectiveScore})`);
    if (!dryRun) {
      await delay(DELAY_MS);
      try {
        await demoteFromShortlist(c.doc.id);
        demoted++;
      } catch (e) {
        log(`    demote failed: ${e.message}`);
      }
    } else {
      demoted++;
    }
  }

  // Execute promotions
  let promoted = 0;
  let promoteFailed = 0;
  for (const c of toPromote) {
    log(`  [PROMOTE] [${c.effectiveScore}] ${c.doc.title || c.doc.url}`);
    if (!dryRun) {
      await delay(DELAY_MS);
      try {
        await moveToShortlist(c.doc.id, c.score, c.breakdown, c.decayApplied);
        promoted++;
      } catch (e) {
        promoteFailed++;
        log(`    promote failed: ${e.message}`);
      }
    } else {
      promoted++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Promoted: ${promoted} | Demoted: ${demoted} | Library: ${libTagged} | Failed: ${promoteFailed}`);

  // Print final shortlist
  console.log('\nFinal Shortlist (projected):');
  winners.forEach(c => {
    const flag = c.inShortlist ? (c.decayApplied ? '↩' : '✓') : '↑';
    console.log(`  ${flag} [${c.effectiveScore}] ${c.doc.title || c.doc.url}`);
  });
  console.log('='.repeat(60));
}

const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const sinceArg = args.find(a => a.startsWith('--since='));
const sinceDays = sinceArg ? parseInt(sinceArg.split('=')[1], 10) : null;

// Cache functions
function loadCache() {
  if (noCache || !existsSync(CACHE_FILE)) return { processed: {} };
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
  process.exit(1);
}

let stats = {
  total: 0,
  promoted: [],
  archivedNoRead: [],
  archivedNoSummary: [],
  skippedNoRead: [],
  skippedNoSummary: [],
  skippedCached: 0,
  skippedTooOld: 0,
};

function log(message) {
  if (verbose) console.log(message);
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
      ...options.headers,
    },
  });
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After') || 60;
    console.warn(`Rate limited. Waiting ${retryAfter}s...`);
    await delay(retryAfter * 1000);
    return apiRequest(endpoint, options);
  }
  if (!response.ok) throw new Error(`API error: ${response.status} ${response.statusText}`);
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
    const docs = (data.results || []).filter(
      doc => doc.category !== 'highlight' && doc.category !== 'note'
    );
    documents.push(...docs);
    cursor = data.nextPageCursor;
    log(`  Fetched ${docs.length} docs (total: ${documents.length})`);
    if (maxDocs && documents.length >= maxDocs) break;
    if (cursor) await delay(DELAY_MS);
  } while (cursor);
  return documents;
}

async function updateDocumentLocation(documentId, location) {
  await apiRequest(`/update/${documentId}/`, {
    method: 'PATCH',
    body: JSON.stringify({ location }),
  });
}

function hasReadMarker(doc) {
  return (doc.summary || '').includes(READ_MARKER) || (doc.notes || '').includes(READ_MARKER);
}
function hasSummary(doc) {
  return (doc.summary || '').length > 0;
}
function isWithinDays(doc, days) {
  if (!days) return true;
  const docDate = new Date(doc.created_at || doc.updated_at);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return docDate >= cutoff;
}

async function archiveAllLater() {
  console.log('='.repeat(60));
  console.log('ARCHIVING ALL LATER ITEMS');
  console.log('='.repeat(60));
  const documents = await fetchDocuments('later');
  console.log(`\nFound ${documents.length} document(s) in Later\n`);
  let archived = 0;
  for (const doc of documents) {
    log(`Archiving: ${doc.title || doc.url}`);
    if (!dryRun) {
      await delay(DELAY_MS);
      await updateDocumentLocation(doc.id, 'archive');
    }
    archived++;
  }
  console.log(`\n${dryRun ? '[DRY RUN] Would archive' : 'Archived'}: ${archived}`);
}

async function nukeLaterArticles(days) {
  console.log('='.repeat(60));
  console.log(`NUKING LATER — archiving everything older than ${days} days`);
  console.log('='.repeat(60));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  console.log(`Cutoff: ${cutoff.toISOString().split('T')[0]}\n`);
  const docs = await fetchDocuments('later');
  let nuked = 0, kept = 0, noDate = 0;
  for (const doc of docs) {
    const savedAt = doc.saved_at || doc.created_at;
    if (!savedAt) { noDate++; continue; }
    const savedDate = new Date(savedAt);
    const daysSince = Math.floor((Date.now() - savedDate) / (1000 * 60 * 60 * 24));
    const tags = Object.keys(doc.tags || {}).map(t => t.toLowerCase());
    if (tags.includes('shortlist')) { kept++; continue; }
    if (savedDate < cutoff) {
      if (!dryRun) {
        await delay(DELAY_MS);
        await updateDocumentLocation(doc.id, 'archive');
      }
      nuked++;
    } else {
      kept++;
    }
    if ((nuked + kept) % 50 === 0) console.log(`  Progress: ${nuked} archived, ${kept} kept...`);
  }
  console.log(`\n${dryRun ? '[DRY RUN] Would archive' : 'Archived'}: ${nuked} | Kept: ${kept} | No date: ${noDate}`);
}

async function processFeed() {
  console.log('='.repeat(60));
  console.log('PROCESSING FEED');
  console.log('='.repeat(60));
  if (sinceDays) console.log(`Filtering to last ${sinceDays} days`);
  let documents = await fetchDocuments('feed', limit);
  stats.total = documents.length;
  if (limit) documents = documents.slice(0, limit);
  console.log(`\nFound ${documents.length} document(s) in Feed\n`);
  if (documents.length === 0) { console.log('Nothing to process.'); return; }

  for (const doc of documents) {
    const title = doc.title || doc.url || `ID: ${doc.id}`;
    const docId = doc.id;
    if (sinceDays && !isWithinDays(doc, sinceDays)) { stats.skippedTooOld++; continue; }
    if (cache.processed[docId]) { stats.skippedCached++; continue; }
    log(`\nProcessing: ${title}`);
    if (!hasSummary(doc)) {
      if (archiveSkipped) {
        if (!dryRun) { await delay(DELAY_MS); await updateDocumentLocation(docId, 'archive'); }
        stats.archivedNoSummary.push(title);
        cache.processed[docId] = { archived: true };
      } else {
        stats.skippedNoSummary.push(title);
      }
      continue;
    }
    if (hasReadMarker(doc)) {
      if (!dryRun) { await delay(DELAY_MS); await updateDocumentLocation(docId, 'later'); }
      stats.promoted.push(title);
      cache.processed[docId] = { promoted: true };
    } else {
      if (archiveSkipped) {
        if (!dryRun) { await delay(DELAY_MS); await updateDocumentLocation(docId, 'archive'); }
        stats.archivedNoRead.push(title);
        cache.processed[docId] = { archived: true };
      } else {
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
  if (dryRun) console.log('(DRY RUN - no changes made)\n');
  console.log(`Total documents checked: ${stats.total}`);
  console.log(`\nPromoted to Later (${stats.promoted.length}):`);
  stats.promoted.length ? stats.promoted.forEach(t => console.log(`  - ${t}`)) : console.log('  (none)');
  if (stats.archivedNoRead.length > 0) {
    console.log(`\nArchived - no READ marker (${stats.archivedNoRead.length}):`);
    stats.archivedNoRead.slice(0, 10).forEach(t => console.log(`  - ${t}`));
    if (stats.archivedNoRead.length > 10) console.log(`  ... and ${stats.archivedNoRead.length - 10} more`);
  }
  if (stats.archivedNoSummary.length > 0) {
    console.log(`\nArchived - no summary (${stats.archivedNoSummary.length}):`);
    stats.archivedNoSummary.slice(0, 10).forEach(t => console.log(`  - ${t}`));
  }
  if (stats.skippedNoRead.length > 0) {
    console.log(`\nSkipped - has summary, no READ marker (${stats.skippedNoRead.length}):`);
    stats.skippedNoRead.forEach(t => console.log(`  - ${t}`));
  }
  if (stats.skippedNoSummary.length > 0) {
    console.log(`\nSkipped - no summary yet (${stats.skippedNoSummary.length}):`);
    stats.skippedNoSummary.forEach(t => console.log(`  - ${t}`));
  }
  if (stats.skippedTooOld > 0) console.log(`\nSkipped - older than ${sinceDays} days: ${stats.skippedTooOld}`);
  if (stats.skippedCached > 0) console.log(`\nSkipped - cached: ${stats.skippedCached}`);
  if (stats.pruned?.length > 0) {
    console.log(`\nPruned - stale (${stats.pruned.length}):`);
    stats.pruned.slice(0, 10).forEach(t => console.log(`  - ${t}`));
    if (stats.pruned.length > 10) console.log(`  ... and ${stats.pruned.length - 10} more`);
  }
  console.log('\n' + '='.repeat(60));
}

async function pruneStaleArticles(days) {
  console.log('='.repeat(60));
  console.log(`PRUNING STALE ARTICLES (not opened in ${days}+ days)`);
  console.log('='.repeat(60));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  log(`Cutoff date: ${cutoff.toISOString().split('T')[0]}`);
  const pruned = [];
  const skipped = [];
  for (const location of ['feed', 'later']) {
    const docs = await fetchDocuments(location);
    log(`\nChecking ${docs.length} doc(s) in ${location}...`);
    for (const doc of docs) {
      const title = doc.title || doc.url || `ID: ${doc.id}`;
      const lastTouched = doc.last_opened_at || doc.created_at;
      if (!lastTouched) { skipped.push(title); continue; }
      const lastDate = new Date(lastTouched);
      const daysSince = Math.floor((Date.now() - lastDate) / (1000 * 60 * 60 * 24));
      if (lastDate < cutoff) {
        if (!dryRun) { await delay(DELAY_MS); await updateDocumentLocation(doc.id, 'archive'); }
        pruned.push(`${title} (${daysSince}d, ${location})`);
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
  if (limit) console.log(`Limit: ${limit}`);
  if (sinceDays) console.log(`Since: ${sinceDays} days`);
  if (pruneStale) console.log(`Prune stale: ON (>${staleDays} days)`);
  if (nukeLater) console.log(`Nuke Later: ON (>${nukeDays} days)`);
  if (scoreShortlist) console.log(`Shortlist: ON (cap: ${SHORTLIST_CAP}, threshold: ${SHORTLIST_THRESHOLD})`);
  console.log('');

  try {
    if (scoreShortlist) {
      await runShortlisting();
      console.log('');
    }
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
    // Only run feed processing if explicitly needed — don't run unconditionally
    if (!scoreShortlist && !pruneStale && !nukeLater && !archiveLater) {
      await processFeed();
    } else if (archiveLater) {
      // already handled above
    } else {
      // feed processing is a separate concern; skip unless nothing else was requested
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
