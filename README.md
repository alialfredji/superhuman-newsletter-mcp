# superhuman-newsletter-mcp

An MCP (Model Context Protocol) server that fetches full post content from two AI newsletters — [Superhuman AI](https://www.superhuman.ai) and [The Code](https://codenewsletter.ai) — and returns it to Claude for weekly digest generation.

No API keys required. No browser automation. Just plain HTTP scraping of two public Beehiiv newsletters.

## Tools

### `fetch_superhuman_newsletters`

Fetches recent posts from **Superhuman AI** (superhuman.ai).

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `count` | number | `7` | 1–30 | Number of recent posts to fetch |

Returns a single markdown document with every post's full content: title, date, author, source URL, body, images, and all external links.

### `fetch_code_newsletter`

Fetches recent posts from **The Code** (codenewsletter.ai).

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `count` | number | `5` | 1–9 | Number of recent posts to fetch (archive serves up to 9) |

Same output format as above.

---

## Usage with Claude

### Option A — Local (stdio)

Connect directly to Claude Desktop or any MCP client that supports stdio.

**Install and build:**

```bash
git clone https://github.com/alialfredji/superhuman-newsletter-mcp.git
cd superhuman-newsletter-mcp
npm install
npm run build
```

**Configure Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "superhuman-newsletter": {
      "command": "node",
      "args": ["/absolute/path/to/superhuman-newsletter-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop after saving.

### Option B — Remote (HTTP)

Use the hosted instance (once deployed to Render) — no local install needed.

**Configure Claude Desktop or OpenCode:**

```json
{
  "mcpServers": {
    "superhuman-newsletter": {
      "url": "https://your-service.onrender.com/mcp"
    }
  }
}
```

### Option C — npx (no install)

Run directly without cloning or installing anything. npm downloads and runs the latest version on demand.

**Configure Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "superhuman-newsletter": {
      "command": "npx",
      "args": ["superhuman-newsletter-mcp"]
    }
  }
}
```

Restart Claude Desktop after saving.

---

## What to ask Claude

Once connected (either mode):

> "Fetch the last 7 Superhuman newsletters and write me a weekly digest"

> "Get the last 5 posts from The Code newsletter and summarize the key developer stories and tools"

> "Pull both newsletters and give me a combined weekly AI + dev digest with must-read links"

Claude receives the full post content directly — no URLs to open, no extra steps.

---

## Deploy to Render

The repo ships with a `render.yaml` and `Dockerfile` — no configuration needed beyond connecting your GitHub account.

### Step 1 — Push to GitHub

Make sure your repo is pushed to GitHub (it already is at `github.com/alialfredji/superhuman-newsletter-mcp`). Render will pull from there.

### Step 2 — Create a Render account

Go to [render.com](https://render.com) and sign up or log in. The free plan is sufficient.

### Step 3 — Connect GitHub

In the Render dashboard, click your avatar (top right) → **Account Settings** → **Connected Accounts** → connect GitHub. Grant access to the `superhuman-newsletter-mcp` repo (or all repos).

### Step 4 — Deploy via Blueprint

1. In the Render dashboard click **New +** → **Blueprint**
2. Find and select the `superhuman-newsletter-mcp` repository
3. Render reads `render.yaml` automatically — you'll see a service named `superhuman-newsletter-mcp` listed
4. Click **Apply** — Render starts building the Docker image

The first build takes ~2–3 minutes (installing deps + compiling TypeScript). Subsequent deploys on every `git push` take ~1 minute.

### Step 5 — Confirm the service is live

Once the build finishes, Render assigns a URL like:
```
https://superhuman-newsletter-mcp.onrender.com
```

Verify it's running:
```bash
curl https://superhuman-newsletter-mcp.onrender.com/health
# → {"status":"ok"}
```

> **Note:** Free-tier services spin down after 15 minutes of inactivity. The first request after sleep takes ~30 seconds to wake up. Paid plans (`starter` and above) stay always-on.

### Step 6 — Connect Claude to the remote server

Add the deployed URL to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "superhuman-newsletter": {
      "url": "https://superhuman-newsletter-mcp.onrender.com/mcp"
    }
  }
}
```

Restart Claude Desktop — the tools are now available from any machine via the cloud.

### What gets deployed

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | `POST` / `GET` / `DELETE` | MCP Streamable HTTP transport |
| `/health` | `GET` | Returns `{"status":"ok"}` for Render health checks |

### Updating the deployment

Every `git push` to `main` triggers an automatic redeploy on Render — no manual steps needed.

---

## Development

```bash
# Install dependencies
npm install

# Run in dev mode — stdio (no build step)
npm run dev

# Run in dev mode — HTTP on port 3000
npm run dev:http

# Build
npm run build

# Run built server — stdio
npm start

# Run built server — HTTP
npm run start:http
```

HTTP mode auto-activates when the `PORT` environment variable is set (as Render does), or when the `--http` flag is passed.

### Project structure

```
src/
  index.ts        # All logic — scrapers, MCP tools, transport modes
Dockerfile        # Docker build for Render
render.yaml       # Render deployment config
tsconfig.json     # TypeScript config
```

### How it works

1. **Tool call received** — Claude requests N posts
2. **Listing scrape** — fetches the newsletter homepage/archive to collect post URLs
3. **Post scrape** — visits each URL, strips noise (nav, ads, sponsor blocks), converts HTML → Markdown via Turndown
4. **JSON-LD extraction** — pulls structured metadata (title, date, author, description, featured image) from each post
5. **Return** — single formatted markdown document handed back to Claude

Sponsor/ad sections (`PRESENTED BY`, `SPONSORED BY`) are automatically stripped. A 300ms polite delay is added between post fetches.

---

## Tech stack

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server + Streamable HTTP transport
- [`express`](https://expressjs.com) — HTTP server for remote mode
- [`node-html-parser`](https://github.com/taoqf/node-fast-html-parser) — HTML parsing
- [`turndown`](https://github.com/mixmark-io/turndown) — HTML → Markdown conversion
- [`zod`](https://zod.dev) — Input schema validation
