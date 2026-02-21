import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { parse } from "node-html-parser";
import TurndownService from "turndown";
import { z } from "zod";
import express from "express";
import { randomUUID } from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PostListing {
  title: string;
  date: string;
  url: string;
  slug: string;
}

interface PostContent extends PostListing {
  author: string;
  subtitle: string;
  content_markdown: string;
  external_links: { text: string; url: string }[];
  featured_image?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = "https://www.superhuman.ai";
const FETCH_DELAY_MS = 300;

const SPONSOR_PATTERNS = [/presented by/i, /sponsored by/i, /advertisement/i];

// ─── HTML → Markdown converter ────────────────────────────────────────────────

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

turndown.addRule("images", {
  filter: "img",
  replacement: (_content, node) => {
    const el = node as { getAttribute: (name: string) => string | null };
    const src = el.getAttribute("src") ?? "";
    const alt = el.getAttribute("alt") ?? "";
    if (!src) return "";
    return `![${alt}](${src})\n`;
  },
});

// Remove empty links that turndown would otherwise keep as bare brackets
turndown.addRule("emptyLinks", {
  filter: (node) =>
    node.nodeName === "A" &&
    !(node as { textContent?: string }).textContent?.trim(),
  replacement: () => "",
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  return res.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Step 1: Scrape post listing ──────────────────────────────────────────────
// Fetches homepage (page 1) or archive pages (?page=N) and extracts the list
// of post slugs, titles, and dates. Each post card on Beehiiv has two <a>
// elements pointing to the same href — one wraps the thumbnail, one wraps the
// title <h2>. We deduplicate by href and read fields from the parent card div.

async function scrapePostListings(page = 1): Promise<PostListing[]> {
  const url =
    page === 1 ? BASE_URL : `${BASE_URL}/archive?page=${page}`;
  const html = await fetchHtml(url);
  const root = parse(html);

  const seen = new Set<string>();
  const listings: PostListing[] = [];

  for (const link of root.querySelectorAll('a[href^="/p/"]')) {
    const href = link.getAttribute("href") ?? "";
    if (!href.startsWith("/p/") || seen.has(href)) continue;
    seen.add(href);

    const slug = href.slice(3); // strip leading "/p/"
    const postUrl = `${BASE_URL}${href}`;

    // The card container is 2 levels up from the <a> (a > div.relative > div.card)
    const card = link.parentNode?.parentNode;

    // Title from <h2> anywhere in the card, or fall back to img alt
    const title =
      card?.querySelector("h2")?.text?.trim() ??
      card?.querySelector("img")?.getAttribute("alt")?.trim() ??
      slug.replace(/-/g, " ");

    // Date from the first <span> in the card (shows "Feb 21, 2026" or "3 hours ago")
    const rawDate = card?.querySelector("span")?.text?.trim() ?? "";

    listings.push({ title, date: rawDate, url: postUrl, slug });
  }

  return listings;
}

async function collectListings(count: number): Promise<PostListing[]> {
  const all: PostListing[] = [];
  let page = 1;

  while (all.length < count) {
    const batch = await scrapePostListings(page);
    if (batch.length === 0) break;

    all.push(...batch);
    if (all.length >= count) break;

    page++;
    await sleep(FETCH_DELAY_MS);
  }

  return all.slice(0, count);
}

// ─── Step 2: Scrape individual post content ───────────────────────────────────
// Beehiiv renders post content inside #content-blocks. We strip noise (nav,
// footer, scripts, style tags, sponsor blocks) then convert to clean markdown.

async function scrapePostContent(listing: PostListing): Promise<PostContent> {
  const html = await fetchHtml(listing.url);
  const root = parse(html);

  // ── Metadata (JSON-LD is most reliable) ───────────────────────────────────
  let title = listing.title;
  let datePublished = listing.date;
  let description = "";
  let featuredImage = "";
  let author = "Zain Kahn";

  for (const script of root.querySelectorAll(
    'script[type="application/ld+json"]'
  )) {
    try {
      const data = JSON.parse(script.text);
      if (data.headline) title = data.headline;
      if (data.datePublished) {
        datePublished = new Date(data.datePublished).toLocaleDateString(
          "en-US",
          { year: "numeric", month: "long", day: "numeric" }
        );
      }
      if (data.description) description = data.description;
      if (data.image?.url) featuredImage = data.image.url;
      if (data.author?.name) author = data.author.name;
    } catch {
      // malformed JSON-LD — skip
    }
  }

  // Fallback to OG meta tags
  if (!title || title === listing.title) {
    title =
      root
        .querySelector('meta[property="og:title"]')
        ?.getAttribute("content") ??
      root.querySelector("h1")?.text?.trim() ??
      title;
  }
  if (!description) {
    description =
      root
        .querySelector('meta[property="og:description"]')
        ?.getAttribute("content") ?? "";
  }
  if (!featuredImage) {
    featuredImage =
      root
        .querySelector('meta[property="og:image"]')
        ?.getAttribute("content") ?? "";
  }

  // ── Content body ──────────────────────────────────────────────────────────
  // Beehiiv's actual post body lives in #content-blocks
  let contentEl =
    root.querySelector("#content-blocks") ??
    root.querySelector(".rendered-post") ??
    root.querySelector("main");

  if (!contentEl) {
    contentEl = root.querySelector("body") ?? root;
  }

  // Strip noise elements
  for (const sel of [
    "script",
    "style",
    "noscript",
    "nav",
    "header",
    "footer",
    "form",
    "button",
    '[class*="subscribe"]',
    '[class*="share"]',
    '[class*="follow"]',
    '[class*="feedback"]',
    '[class*="poll"]',
    ".advertisement",
  ]) {
    for (const el of contentEl.querySelectorAll(sel)) {
      el.remove();
    }
  }

  // Strip sponsor/ad sections (remove the element whose text matches)
  for (const el of contentEl.querySelectorAll("h1,h2,h3,h4,p,div")) {
    if (SPONSOR_PATTERNS.some((p) => p.test(el.text ?? ""))) {
      el.remove();
    }
  }

  // ── Convert HTML → Markdown ───────────────────────────────────────────────
  let markdown = turndown.turndown(contentEl.innerHTML);
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

  // ── Collect external links ────────────────────────────────────────────────
  const seenLinks = new Set<string>();
  const externalLinks: { text: string; url: string }[] = [];

  for (const a of contentEl.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    const text = a.text?.trim() ?? "";
    if (
      href &&
      !href.startsWith("#") &&
      !href.includes("superhuman.ai") &&
      !href.includes("beehiiv.com") &&
      !href.includes("twitter.com/intent") &&
      !href.includes("facebook.com/sharer") &&
      !href.includes("linkedin.com/sharing") &&
      text &&
      !seenLinks.has(href)
    ) {
      seenLinks.add(href);
      externalLinks.push({ text, url: href });
    }
  }

  return {
    ...listing,
    title,
    date: datePublished,
    author,
    subtitle: description,
    content_markdown: markdown,
    external_links: externalLinks,
    featured_image: featuredImage || undefined,
  };
}

// ─── Format for Claude ────────────────────────────────────────────────────────

function formatDigest(posts: PostContent[]): string {
  const divider = "\n\n" + "─".repeat(80) + "\n\n";

  const fetchedAt = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const header = [
    `# Superhuman AI Newsletter — ${posts.length} Most Recent Posts`,
    `Compiled: ${fetchedAt}`,
    "",
    "Full content of each post is included below. Use this to produce a weekly digest",
    "with combined top stories, must-read links, and a reference back to each source URL.",
  ].join("\n");

  const sections = posts.map((post, i) => {
    const meta = [
      `## [Post ${i + 1}/${posts.length}] ${post.title}`,
      `**Date:** ${post.date}  |  **Author:** ${post.author}`,
      `**Source:** <${post.url}>`,
      post.subtitle ? `**Summary:** ${post.subtitle}` : "",
      post.featured_image ? `\n![Featured Image](${post.featured_image})\n` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const links =
      post.external_links.length > 0
        ? "\n\n**Links referenced in this post:**\n" +
          post.external_links
            .map((l) => `- [${l.text}](${l.url})`)
            .join("\n")
        : "";

    return `${meta}\n\n${post.content_markdown}${links}`;
  });

  return header + divider + sections.join(divider);
}

// ─── The Code newsletter scraper ─────────────────────────────────────────────
// codenewsletter.ai — also hosted on Beehiiv.
// Archive: https://codenewsletter.ai/archive (~9 posts via plain fetch).
// Posts:   https://codenewsletter.ai/p/{slug}
// Each post card is a single <a href="/p/slug"> with <h3> (title) + <p>.

const CODE_BASE_URL = "https://codenewsletter.ai";
const CODE_AUTHOR = "The Code team";

async function scrapeCodeListings(): Promise<PostListing[]> {
  const html = await fetchHtml(`${CODE_BASE_URL}/archive`);
  const root = parse(html);
  const seen = new Set<string>();
  const listings: PostListing[] = [];

  for (const link of root.querySelectorAll('a[href^="/p/"]')) {
    const href = link.getAttribute("href") ?? "";
    if (!href.startsWith("/p/") || seen.has(href)) continue;
    seen.add(href);
    const slug = href.slice(3);
    const postUrl = `${CODE_BASE_URL}${href}`;
    const title = link.querySelector("h3")?.text?.trim() ?? slug.replace(/-/g, " ");
    const rawDate = link.querySelector("p")?.text?.trim() ?? "";
    listings.push({ title, date: rawDate, url: postUrl, slug });
  }

  return listings;
}

async function scrapeCodePostContent(listing: PostListing): Promise<PostContent> {
  const html = await fetchHtml(listing.url);
  const root = parse(html);

  let title = listing.title;
  let datePublished = listing.date;
  let description = "";
  let featuredImage = "";
  const author = CODE_AUTHOR;

  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.text);
      if (data.headline) title = data.headline;
      if (data.datePublished) {
        datePublished = new Date(data.datePublished).toLocaleDateString("en-US", {
          year: "numeric", month: "long", day: "numeric",
        });
      }
      if (data.description) description = data.description;
      if (data.image?.url) featuredImage = data.image.url;
    } catch { /* skip */ }
  }

  if (!title || title === listing.title) {
    title =
      root.querySelector('meta[property="og:title"]')?.getAttribute("content") ??
      root.querySelector("h1")?.text?.trim() ?? title;
  }
  if (!description) {
    description = root.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? "";
  }
  if (!featuredImage) {
    featuredImage = root.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? "";
  }

  let contentEl =
    root.querySelector("#content-blocks") ??
    root.querySelector(".rendered-post") ??
    root.querySelector("main");
  if (!contentEl) contentEl = root.querySelector("body") ?? root;

  for (const sel of [
    "script", "style", "noscript", "nav", "header", "footer", "form", "button",
    '[class*="subscribe"]', '[class*="feedback"]', ".advertisement",
  ]) {
    for (const el of contentEl.querySelectorAll(sel)) el.remove();
  }

  // Strip sponsor/ad sections — only check leaf text elements, not parent divs
  for (const el of contentEl.querySelectorAll("h1,h2,h3,h4,h5,p")) {
    if (SPONSOR_PATTERNS.some((p) => p.test(el.text ?? ""))) el.remove();
  }

  let markdown = turndown.turndown(contentEl.innerHTML);
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

  const seenLinks = new Set<string>();
  const externalLinks: { text: string; url: string }[] = [];
  for (const a of contentEl.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    const text = a.text?.trim() ?? "";
    if (
      href && !href.startsWith("#") &&
      !href.includes("codenewsletter.ai") && !href.includes("beehiiv.com") &&
      !href.includes("twitter.com/intent") && !href.includes("facebook.com/sharer") &&
      !href.includes("linkedin.com/sharing") && text && !seenLinks.has(href)
    ) {
      seenLinks.add(href);
      externalLinks.push({ text, url: href });
    }
  }

  return {
    ...listing, title, date: datePublished, author,
    subtitle: description, content_markdown: markdown,
    external_links: externalLinks, featured_image: featuredImage || undefined,
  };
}

function formatCodeDigest(posts: PostContent[]): string {
  const divider = "\n\n" + "─".repeat(80) + "\n\n";
  const fetchedAt = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const header = [
    `# The Code Newsletter — ${posts.length} Most Recent Posts`,
    `Compiled: ${fetchedAt}`,
    "",
    "Full content of each post is included below. Use this to produce a weekly digest",
    "with combined top stories, must-read links, and a reference back to each source URL.",
  ].join("\n");
  const sections = posts.map((post, i) => {
    const meta = [
      `## [Post ${i + 1}/${posts.length}] ${post.title}`,
      `**Date:** ${post.date}  |  **Author:** ${post.author}`,
      `**Source:** <${post.url}>`,
      post.subtitle ? `**Summary:** ${post.subtitle}` : "",
      post.featured_image ? `\n![Featured Image](${post.featured_image})\n` : "",
    ].filter(Boolean).join("\n");
    const links =
      post.external_links.length > 0
        ? "\n\n**Links referenced in this post:**\n" +
          post.external_links.map((l) => `- [${l.text}](${l.url})`).join("\n")
        : "";
    return `${meta}\n\n${post.content_markdown}${links}`;
  });
  return header + divider + sections.join(divider);
}

// ─── MCP Server Factory ──────────────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: "superhuman-newsletter",
    version: "3.0.0",
  });

  server.registerTool(
  "fetch_superhuman_newsletters",
  {
    title: "Fetch Superhuman AI Newsletters",
    description:
      "Fetches the N most recent posts from the Superhuman AI newsletter (superhuman.ai). " +
      "Step 1: loads the homepage to collect post URLs. " +
      "Step 2: visits each post URL and scrapes its full content. " +
      "Returns one large markdown document containing every post in full — " +
      "title, date, source URL, body, images, and all external links — " +
      "ready for Claude to synthesize into a weekly digest without needing to open any URLs itself.",
    inputSchema: z.object({
      count: z
        .number()
        .min(1)
        .max(30)
        .default(7)
        .describe(
          "How many recent newsletter posts to fetch. Default is 7 (roughly one week of daily posts)."
        ),
    }),
  },
  async ({ count }) => {
    try {
      // Step 1 — collect post URLs from the homepage / archive pages
      const listings = await collectListings(count);

      if (listings.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No posts found on superhuman.ai. The site may be temporarily unavailable.",
            },
          ],
        };
      }

      // Step 2 — fetch full content for each post
      const posts: PostContent[] = [];

      for (let i = 0; i < listings.length; i++) {
        try {
          const content = await scrapePostContent(listings[i]);
          posts.push(content);
        } catch (err) {
          // Keep a placeholder so the digest still includes every post slot
          posts.push({
            ...listings[i],
            author: "Zain Kahn",
            subtitle: "",
            content_markdown: `_Could not fetch content: ${
              err instanceof Error ? err.message : String(err)
            }_`,
            external_links: [],
          });
        }

        // Polite delay between post fetches (skip after last one)
        if (i < listings.length - 1) {
          await sleep(FETCH_DELAY_MS);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatDigest(posts),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  }
  );

server.registerTool(
  "fetch_code_newsletter",
  {
    title: "Fetch The Code Newsletter",
    description:
      "Fetches the N most recent posts from The Code newsletter (codenewsletter.ai). " +
      "Step 1: loads the archive page to collect post URLs. " +
      "Step 2: visits each post URL and scrapes its full content. " +
      "Returns one large markdown document containing every post in full — " +
      "title, date, source URL, body, images, and all external links — " +
      "ready for Claude to synthesize into a weekly digest without needing to open any URLs itself. " +
      "Note: the archive page serves up to ~9 posts via plain HTTP; fetching more than 9 will return whatever is available.",
    inputSchema: z.object({
      count: z
        .number()
        .min(1)
        .max(9)
        .default(5)
        .describe(
          "How many recent newsletter posts to fetch. Default is 5. Maximum is 9 (archive page limit)."
        ),
    }),
  },
  async ({ count }) => {
    try {
      // Step 1 — collect post URLs from the archive page
      const listings = await scrapeCodeListings();
      const target = listings.slice(0, count);

      if (target.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No posts found on codenewsletter.ai. The site may be temporarily unavailable.",
            },
          ],
        };
      }

      // Step 2 — fetch full content for each post
      const posts: PostContent[] = [];

      for (let i = 0; i < target.length; i++) {
        try {
          const content = await scrapeCodePostContent(target[i]);
          posts.push(content);
        } catch (err) {
          posts.push({
            ...target[i],
            author: CODE_AUTHOR,
            subtitle: "",
            content_markdown: `_Could not fetch content: ${
              err instanceof Error ? err.message : String(err)
            }_`,
            external_links: [],
          });
        }

        if (i < target.length - 1) {
          await sleep(FETCH_DELAY_MS);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatCodeDigest(posts),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  }
  );
  return server;
}

// ─── Transport Modes ────────────────────────────────────────────────────────

async function startStdioServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}

async function startHttpServer() {
  const app = express();
  app.use(express.json());

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.all("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (!sessionId && req.method === "POST" && req.body?.method === "initialize") {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
        };
        const server = createServer();
        await server.connect(transport);
      } else {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  const PORT = process.env.PORT ?? 3000;
  app.listen(PORT, () => {
    console.error(`MCP HTTP server listening on port ${PORT}`);
    console.error(`Endpoint: http://localhost:${PORT}/mcp`);
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const isHttpMode = process.argv.includes("--http") || process.env.PORT !== undefined;
  if (isHttpMode) {
    await startHttpServer();
  } else {
    await startStdioServer();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
