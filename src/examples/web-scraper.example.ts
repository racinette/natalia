import { z } from "zod";
import { defineStep, defineWorkflow, defineWorkflowHeader } from "../workflow";

/**
 * Showcases:
 * - defineWorkflowHeader for self-referential (recursive/tree) workflows
 * - URL as stable idempotency key: the same URL always maps to the same
 *   workflow idempotency key, so cycles and duplicate page visits are prevented by the
 *   engine's idempotent start semantics — no explicit visited-set needed
 * - detached child workflows for parallel tree fan-out
 * - maxLinksPerPage + maxDepth to bound the crawl
 * - streams for aggregating discovered pages across the entire crawl tree
 */

// =============================================================================
// SCHEMAS
// =============================================================================

const PageScraperArgs = z.object({
  url: z.url(),
  /** Only follow links whose href starts with this prefix (same-domain filter). */
  baseUrl: z.string(),
  maxDepth: z.number().int().min(0),
  /** Current recursion depth — callers omit this; defaults to 0 at the root. */
  depth: z.number().int().min(0).default(0),
  /** Cap on outbound links followed per page — prevents explosive fan-out. */
  maxLinksPerPage: z.number().int().min(1).default(10),
});

const PageScraperResult = z.object({
  url: z.string(),
  title: z.string(),
});

const DiscoveredPage = z.object({
  url: z.string(),
  title: z.string(),
  depth: z.number(),
  linksFound: z.number(),
});

// =============================================================================
// STEPS
// =============================================================================

const fetchPage = defineStep({
  name: "fetchPage",
  execute: async ({ signal }, url: string, baseUrl: string) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    const html = await res.text();

    const title =
      /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? url;

    // Resolve all hrefs to absolute URLs, keep only same-base links.
    const links = [...html.matchAll(/href="([^"#"]+)"/g)]
      .map(([, href]) => {
        try {
          return new URL(href, url).href;
        } catch {
          return null;
        }
      })
      .filter(
        (href): href is string =>
          href !== null && href.startsWith(baseUrl) && href !== url,
      );

    return { title, links: [...new Set(links)] };
  },
  schema: z.object({
    title: z.string(),
    links: z.array(z.string()),
  }),
  retryPolicy: { maxAttempts: 3, intervalSeconds: 2, maxIntervalSeconds: 30 },
});

// =============================================================================
// HEADER
//
// Declared before the workflow itself so the workflow can reference its own
// type in childWorkflows — the canonical self-referential pattern.
// Spread into defineWorkflow below so name, args, and result are declared once.
// =============================================================================

export const pageScraperHeader = defineWorkflowHeader({
  name: "pageScraper",
  args: PageScraperArgs,
  result: PageScraperResult,
});

// =============================================================================
// WORKFLOW
// =============================================================================

export const pageScraperWorkflow = defineWorkflow({
  ...pageScraperHeader,
  steps: { fetchPage },
  childWorkflows: { page: pageScraperHeader }, // self-reference via header
  streams: { discovered: DiscoveredPage },
  events: { done: true },
  retention: {
    complete: 7 * 24 * 3600,
    failed: 30 * 24 * 3600,
    terminated: 3600,
  },

  async execute(ctx, args) {
    // Depth limit reached — return immediately without fetching.
    // The engine already ensured this workflow started at most once for this
    // URL (idempotent start), so returning here is safe and cheap.
    if (args.depth > args.maxDepth) {
      return { url: args.url, title: "" };
    }

    const page = await ctx.join(ctx.steps.fetchPage(args.url, args.baseUrl));

    await ctx.streams.discovered.write({
      url: args.url,
      title: page.title,
      depth: args.depth,
      linksFound: page.links.length,
    });

    // Fan out to child pages in parallel.
    //
    // Each child's idempotency key is the target URL itself.
    // If another page in the crawl already started a workflow for this URL
    // — whether via a different path or a back-edge creating a cycle — the
    // engine treats the start as a no-op and the duplicate is silently
    // discarded. No explicit cycle detection or visited-set is needed.
    const links = page.links.slice(0, args.maxLinksPerPage);
    for (const link of links) {
      await ctx.childWorkflows.page.startDetached({
        idempotencyKey: link,
        args: {
          url: link,
          baseUrl: args.baseUrl,
          depth: args.depth + 1,
          maxDepth: args.maxDepth,
          maxLinksPerPage: args.maxLinksPerPage,
        },
        retention: {
          complete: 7 * 24 * 3600,
          failed: 30 * 24 * 3600,
          terminated: 3600,
        },
      });
    }

    await ctx.events.done.set();
    return { url: args.url, title: page.title };
  },
});
