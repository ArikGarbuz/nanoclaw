/**
 * Web Scraper MCP Tool — fetch and parse web pages
 *
 * Provides autonomous web scraping capability to agents. The agent can invoke
 * this tool when a user provides a URL or asks to scan a topic. Handles:
 * - Timeouts (10s max)
 * - Blocked/forbidden sites (403, 401)
 * - Network errors (graceful fallback)
 * - Large responses (200KB limit)
 * - Content extraction (text-only, no images/scripts)
 *
 * Output is plain text suitable for agent processing and formatting per
 * the system prompt (BLUF, Insights, Operational Impact).
 */

import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[web-scraper] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/**
 * Extract readable text from HTML using cheerio.
 * Removes scripts, styles, and metadata; preserves structure via spacing.
 */
function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);

  // Remove noisy elements
  $('script, style, meta, link, noscript, svg, iframe').remove();

  // Extract text with some structure preservation
  let text = '';
  $('body, article, main, [role="main"]').each((_, elem) => {
    text = $(elem).text();
    return false; // break on first match
  });

  // Fallback to full document if no body found
  if (!text.trim()) {
    text = $('*').text();
  }

  // Normalize whitespace: collapse multiple spaces/newlines, preserve paragraphs
  text = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  return text;
}

/**
 * Validate and normalize URL.
 */
function validateUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export const fetchAndScrapePage: McpToolDefinition = {
  tool: {
    name: 'fetch_and_scrape_webpage',
    description:
      'Fetch and parse a webpage, extracting plain text content. Use this when a user provides a URL or asks you to research a topic online. Output is text-only suitable for processing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch (must start with http:// or https://)',
        },
      },
      required: ['url'],
    },
  },
  async handler(args) {
    const urlString = args.url as string;
    if (!urlString) return err('url is required');

    const url = validateUrl(urlString);
    if (!url) return err(`Invalid URL: ${urlString}. Must start with http:// or https://`);

    try {
      log(`Fetching: ${url}`);

      const response = await axios.get(url, {
        timeout: 10_000, // 10 second timeout
        maxContentLength: 200_000, // 200KB max
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        // Don't throw on non-2xx status; we handle them below
        validateStatus: () => true,
      });

      // Check status code
      if (response.status === 403 || response.status === 401) {
        return err(
          `Access denied (HTTP ${response.status}). The site blocks automated access. Try visiting the URL manually or using a different source.`
        );
      }

      if (response.status === 404) {
        return err(`Page not found (HTTP 404). Check the URL and try again.`);
      }

      if (response.status >= 400) {
        return err(`HTTP error ${response.status}. The site returned an error. Try again or use a different source.`);
      }

      if (response.status < 200 || response.status >= 300) {
        return err(`Unexpected HTTP status ${response.status}. Unable to fetch the page.`);
      }

      // Check content type
      const contentType = response.headers['content-type'] as string;
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xml')) {
        return err(`Unsupported content type: ${contentType}. This tool only handles HTML/XML pages.`);
      }

      // Extract text
      const html = response.data as string;
      if (!html || html.trim().length === 0) {
        return err('Page returned empty content.');
      }

      const text = extractTextFromHtml(html);

      if (text.trim().length === 0) {
        return err('No readable text found on the page. It may be JavaScript-rendered or dynamic.');
      }

      // Truncate if very large
      const maxChars = 50_000;
      const truncated = text.length > maxChars ? text.slice(0, maxChars) + '\n[... truncated ...]' : text;

      log(`Successfully scraped ${text.length} chars from ${url}`);
      return ok(truncated);
    } catch (error) {
      const axiosErr = error as AxiosError | Error;

      if (axiosErr instanceof axios.AxiosError) {
        if (axiosErr.code === 'ECONNABORTED') {
          return err('Request timeout (10s). The site is too slow or unresponsive.');
        }
        if (axiosErr.code === 'ENOTFOUND') {
          return err(`Domain not found: ${url}. Check the URL spelling.`);
        }
        if (axiosErr.code === 'ECONNREFUSED') {
          return err(`Connection refused. The site may be down or blocking automated access.`);
        }
        if (axiosErr.message.includes('ECONNRESET')) {
          return err(`Connection reset. The site rejected the request.`);
        }
      }

      log(`Scrape error for ${url}: ${error instanceof Error ? error.message : String(error)}`);
      return err(
        `Failed to fetch the page: ${error instanceof Error ? error.message : 'Unknown error'}. Try again or use a different source.`
      );
    }
  },
};

// Register the tool at module load time
registerTools([fetchAndScrapePage]);
