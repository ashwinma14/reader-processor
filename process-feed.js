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
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

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
const stats = {
  total: 0,
  promoted: [],
  skippedNoRead: [],
  skippedNoSummary: [],
  skippedCached: 0
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

async function fetchAllFeedDocuments() {
  const documents = [];
  let cursor = null;

  log('Fetching documents from Feed...');

  do {
    const endpoint = cursor
      ? `/list/?location=feed&pageCursor=${cursor}`
      : '/list/?location=feed';

    const data = await apiRequest(endpoint);

    // Filter to only get actual documents (not highlights/notes)
    const docs = (data.results || []).filter(doc =>
      doc.category !== 'highlight' && doc.category !== 'note'
    );

    documents.push(...docs);
    cursor = data.nextPageCursor;

    log(`  Fetched ${docs.length} documents (total: ${documents.length})`);

    if (cursor) {
      await delay(DELAY_MS);
    }
  } while (cursor);

  return documents;
}

async function moveToLibrary(documentId) {
  if (dryRun) {
    log(`  [DRY RUN] Would move document ${documentId} to Later`);
    return;
  }

  await apiRequest(`/update/${documentId}/`, {
    method: 'PATCH',
    body: JSON.stringify({ location: 'later' })
  });

  log(`  Moved document ${documentId} to Later`);
}

function hasReadMarker(doc) {
  // Check summary field (where Ghostreader puts its verdict)
  const summary = doc.summary || '';
  const notes = doc.notes || '';
  return summary.includes(READ_MARKER) || notes.includes(READ_MARKER);
}

function hasSummary(doc) {
  // Check if Ghostreader has processed this document
  const summary = doc.summary || '';
  return summary.length > 0;
}

async function processDocuments(documents) {
  for (const doc of documents) {
    const title = doc.title || doc.url || `ID: ${doc.id}`;
    const docId = doc.id;

    // Skip if already processed
    if (cache.processed[docId]) {
      log(`\nSkipping (cached): ${title}`);
      stats.skippedCached++;
      continue;
    }

    log(`\nProcessing: ${title}`);

    if (!hasSummary(doc)) {
      log(`  No summary yet (Ghostreader hasn't processed)`);
      stats.skippedNoSummary.push(title);
      // Don't cache - we want to recheck when Ghostreader runs
      continue;
    }

    if (hasReadMarker(doc)) {
      log(`  Found "${READ_MARKER}" marker - promoting to Library`);
      await delay(DELAY_MS);
      await moveToLibrary(docId);
      stats.promoted.push(title);
      cache.processed[docId] = { promoted: true };
    } else {
      log(`  Has summary but no READ marker`);
      stats.skippedNoRead.push(title);
      cache.processed[docId] = { promoted: false };
    }
  }

  saveCache(cache);
}

function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  if (dryRun) {
    console.log('(DRY RUN - no changes made)\n');
  }

  console.log(`Total documents in Feed: ${stats.total}`);

  console.log(`\nPromoted to Library (${stats.promoted.length}):`);
  if (stats.promoted.length > 0) {
    stats.promoted.forEach(t => console.log(`  - ${t}`));
  } else {
    console.log('  (none)');
  }

  console.log(`\nSkipped - has summary, no READ marker (${stats.skippedNoRead.length}):`);
  if (stats.skippedNoRead.length > 0) {
    stats.skippedNoRead.forEach(t => console.log(`  - ${t}`));
  } else {
    console.log('  (none)');
  }

  console.log(`\nSkipped - no summary yet (${stats.skippedNoSummary.length}):`);
  if (stats.skippedNoSummary.length > 0) {
    stats.skippedNoSummary.forEach(t => console.log(`  - ${t}`));
  } else {
    console.log('  (none)');
  }

  if (stats.skippedCached > 0) {
    console.log(`\nSkipped - already processed (cached): ${stats.skippedCached}`);
  }

  console.log('\n' + '='.repeat(60));
}

async function main() {
  console.log('Reader Feed Processor');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Verbose: ${verbose ? 'ON' : 'OFF'}`);
  if (limit) console.log(`Limit: ${limit} document(s)`);
  console.log('');

  try {
    let documents = await fetchAllFeedDocuments();
    stats.total = documents.length;

    console.log(`Found ${documents.length} document(s) in Feed`);

    if (limit && documents.length > limit) {
      console.log(`Processing only first ${limit} (use --limit=N to change)`);
      documents = documents.slice(0, limit);
    }
    console.log('');

    if (documents.length === 0) {
      console.log('No documents to process.');
      return;
    }

    await processDocuments(documents);
    printSummary();

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
