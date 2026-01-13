# Reader Feed Processor

Automatically processes your Readwise Reader Feed and promotes articles to your Library based on Ghostreader's verdict.

## What It Does

1. Fetches all documents from your Reader Feed
2. For each document, checks if Ghostreader has processed it (has highlights)
3. If any highlight contains "📖 READ", moves the document from Feed to Library (Inbox)
4. Outputs a summary of actions taken

## Setup

### 1. Get Your Readwise Token

1. Go to [readwise.io/access_token](https://readwise.io/access_token)
2. Copy your access token

### 2. Run Locally

```bash
# Set your token and run
READWISE_TOKEN=your_token_here node process-feed.js

# Dry run (see what would happen without making changes)
READWISE_TOKEN=your_token_here node process-feed.js --dry-run --verbose

# Verbose mode (see each document being processed)
READWISE_TOKEN=your_token_here node process-feed.js --verbose
```

### 3. Set Up GitHub Actions (Automated Hourly Runs)

1. Push this repository to GitHub
2. Go to your repository Settings > Secrets and variables > Actions
3. Click "New repository secret"
4. Name: `READWISE_TOKEN`
5. Value: Your Readwise access token
6. Click "Add secret"

The workflow will now run automatically every hour.

### 4. Manual Trigger via GitHub

1. Go to your repository on GitHub
2. Click the "Actions" tab
3. Select "Process Reader Feed" workflow
4. Click "Run workflow" button
5. Select the branch and click "Run workflow"

## CLI Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would happen without making changes |
| `--verbose` | Show each document being processed |

## Output Example

```
Reader Feed Processor
Mode: LIVE
Verbose: ON

Found 15 document(s) in Feed

Processing: Article Title Here
  Found "📖 READ" marker - promoting to Library

Processing: Another Article
  Has 3 highlight(s) but no READ marker

============================================================
SUMMARY
============================================================
Total documents in Feed: 15

Promoted to Library (3):
  - Article Title Here
  - Great Read About X
  - Must Read: Y

Skipped - processed, no READ marker (8):
  - Another Article
  ...

Skipped - not yet processed by Ghostreader (4):
  - New Article
  ...
============================================================
```

## Requirements

- Node.js 18+ (uses native fetch)
- Readwise Reader account with API access

## License

MIT
