#!/usr/bin/env node

const API_BASE = 'https://readwise.io/api/v3';
const DELAY_MS = 3000; // 20 req/min = 1 per 3 seconds
const READ_MARKER = '📖 READ';

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

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
  skippedNoHighlights: []
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

async function fetchHighlightsForDocument(documentId) {
  const highlights = [];
  let cursor = null;

  do {
    const endpoint = cursor
      ? `/list/?category=highlight&pageCursor=${cursor}`
      : '/list/?category=highlight';

    const data = await apiRequest(endpoint);

    // Filter highlights that belong to this document
    const docHighlights = (data.results || []).filter(h => h.parent_id === documentId);
    highlights.push(...docHighlights);

    cursor = data.nextPageCursor;

    // If we found highlights for this doc, we might be done
    // But we need to check all pages to be thorough
    if (cursor) {
      await delay(DELAY_MS);
    }
  } while (cursor);

  return highlights;
}

async function moveToLibrary(documentId) {
  if (dryRun) {
    log(`  [DRY RUN] Would move document ${documentId} to Inbox`);
    return;
  }

  await apiRequest(`/update/${documentId}/`, {
    method: 'PATCH',
    body: JSON.stringify({ location: 'new' })
  });

  log(`  Moved document ${documentId} to Inbox`);
}

function hasReadMarker(highlights) {
  return highlights.some(h => {
    const content = h.content || h.text || '';
    return content.includes(READ_MARKER);
  });
}

async function processDocuments(documents) {
  for (const doc of documents) {
    const title = doc.title || doc.url || `ID: ${doc.id}`;
    log(`\nProcessing: ${title}`);

    await delay(DELAY_MS);
    const highlights = await fetchHighlightsForDocument(doc.id);

    if (highlights.length === 0) {
      log(`  No highlights yet (Ghostreader hasn't processed)`);
      stats.skippedNoHighlights.push(title);
      continue;
    }

    if (hasReadMarker(highlights)) {
      log(`  Found "${READ_MARKER}" marker - promoting to Library`);
      await delay(DELAY_MS);
      await moveToLibrary(doc.id);
      stats.promoted.push(title);
    } else {
      log(`  Has ${highlights.length} highlight(s) but no READ marker`);
      stats.skippedNoRead.push(title);
    }
  }
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

  console.log(`\nSkipped - processed, no READ marker (${stats.skippedNoRead.length}):`);
  if (stats.skippedNoRead.length > 0) {
    stats.skippedNoRead.forEach(t => console.log(`  - ${t}`));
  } else {
    console.log('  (none)');
  }

  console.log(`\nSkipped - not yet processed by Ghostreader (${stats.skippedNoHighlights.length}):`);
  if (stats.skippedNoHighlights.length > 0) {
    stats.skippedNoHighlights.forEach(t => console.log(`  - ${t}`));
  } else {
    console.log('  (none)');
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
