# Superhuman AI Newsletter MCP Server

An MCP (Model Context Protocol) server that fetches posts from [Superhuman AI](https://www.superhuman.ai) and returns their full content to Claude for weekly digest generation.

## What it does

Exposes two tools to Claude:

- **`fetch_superhuman_posts`** — Fetches the N most recent newsletter posts (default: 7, one per day). Returns each post's full content as markdown, including all external links, images, date, and a direct source URL.
- **`fetch_superhuman_post`** — Fetches a single post by URL or slug for deeper reading.

## Setup

### 1. Install and build

```bash
cd superhuman-mcp
npm install
npm run build
```

### 2. Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "superhuman-newsletter": {
      "command": "node",
      "args": ["/Users/ali.alfredji/dev/vibe-code/superhuman-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop after saving.

## Usage in Claude

Once connected, you can ask Claude things like:

> "Fetch the last 7 Superhuman newsletters and write me a weekly digest"

> "Get the last 5 Superhuman posts and summarize the key AI stories, must-read articles, and any notable tools mentioned"

> "Fetch the Superhuman post about Tesla's Cybercab"

Claude will call the appropriate tool, receive the full markdown content of each post, and synthesize a digest that includes:

- Combined weekly summary of top stories
- Must-read external articles and links
- Per-day highlights with back-references to the original post URLs
- Notable themes across the week

## Tools reference

### `fetch_superhuman_posts`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `count` | number | `7` | Number of recent posts to fetch (1–30) |

Returns all posts as a single formatted markdown document ready for Claude to summarize.

### `fetch_superhuman_post`

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | Full URL (`https://www.superhuman.ai/p/...`) or just the slug |

## Development

```bash
# Run in dev mode (tsx, no build step)
npm run dev

# Build
npm run build

# Run built server
npm start
```

## Notes

- Fetches use plain HTTP — no browser/Playwright needed (the site renders server-side)
- Sponsor/ad sections ("PRESENTED BY") are automatically stripped from content
- A 500ms delay is added between post fetches to be respectful to the server
- Pagination is handled automatically — requesting 14 posts transparently fetches pages 1 and 2
