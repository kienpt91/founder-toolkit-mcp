import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  createNodeResolver,
  emailAuthSchema,
  emailAuthShape,
  runEmailAuthCheck,
  shapeEmailAuth,
  type DnsResolver,
} from "./emailauth.js";
import { errorMessage, ToolkitError } from "./errors.js";
import type { FetchLike } from "./http.js";
import {
  freeAuditSchema,
  freeAuditShape,
  SEO_CHECKS,
  SEO_SLUGS,
  SeoBoltClient,
  seoCheckSchema,
  seoCheckShape,
  type Shaped,
} from "./seobolt.js";
import { leaderboardShape, searchShape, ShowMrrClient, startupShape } from "./showmrr.js";
import { clip } from "./text.js";
import { VERSION } from "./version.js";

export interface ServerDeps {
  fetch?: FetchLike;
  resolver?: DnsResolver;
  seoTimeoutMs?: number;
  mrrTimeoutMs?: number;
}

const MAX_OUTPUT_CHARS = 40_000;

const INSTRUCTIONS = [
  "Free, no-API-key tools. seo_* tools send the audited domain or URL to seobolt.app and mrr_* tools send queries to showmrr.com (both operated by the author of this server); email_auth_check runs local DNS lookups only.",
  "Anonymous rate limits apply (SEOBolt: a handful of calls per 5 minutes per IP). On a rate-limit error do not retry in a loop; report it to the user.",
  "ShowMRR figures with verification 'NOT verified' must never be presented as verified revenue.",
].join(" ");

function seoCheckDescription(): string {
  const lines = SEO_SLUGS.map((slug) => `- ${slug} (${SEO_CHECKS[slug].input}): ${SEO_CHECKS[slug].purpose}`);
  return [
    "Run ONE focused SEOBolt checker against a public domain or page (sends the target to seobolt.app). Use after seo_free_audit points at an area, or when the user asks about one specific thing (llms.txt, robots, sitemap, meta tags, structured data...).",
    "Input: `tool` plus `target`. Domain checkers want a domain; page checkers want a page URL. Returns verdict, pass/warn/fail counts and per-check detail with fixes.",
    "Rate limit: anonymous, roughly 3-10 calls per 5 minutes per IP depending on the checker. On a rate-limit error stop and tell the user; do not loop.",
    "Checkers:",
    ...lines,
  ].join("\n");
}

function parseInput<S extends z.ZodTypeAny>(schema: S, args: unknown, tool: string): z.output<S> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw new ToolkitError("invalid_input", `${tool}: ${detail}`);
  }
  return parsed.data;
}

async function respond(run: () => Promise<Shaped>): Promise<CallToolResult> {
  try {
    const { summary, data } = await run();
    return { content: [{ type: "text", text: clip(`${summary}\n\n${JSON.stringify(data)}`, MAX_OUTPUT_CHARS) }] };
  } catch (err) {
    const code = err instanceof ToolkitError ? err.code : "internal";
    return { isError: true, content: [{ type: "text", text: `Error (${code}): ${errorMessage(err)}` }] };
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function createServer(deps: ServerDeps = {}): McpServer {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const resolver = deps.resolver ?? createNodeResolver();
  const seo = new SeoBoltClient(fetchImpl, deps.seoTimeoutMs);
  const mrr = new ShowMrrClient(fetchImpl, deps.mrrTimeoutMs);

  const server = new McpServer({ name: "founder-toolkit-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "seo_free_audit",
    {
      title: "SEOBolt free site audit",
      description:
        "Run SEOBolt's free anonymous audit for a public domain (sends the domain to seobolt.app). Returns an overall score, seo and llm sub-scores, and prioritized recommendations with how-to-fix text. Use it first for a broad overview of a site's technical SEO and AI-search readiness, then drill down with seo_check. Rate limit: anonymous, about 5 audits per 5 minutes per IP; on a rate-limit error stop and tell the user instead of retrying.",
      inputSchema: freeAuditShape,
      annotations: { title: "SEOBolt free site audit", ...READ_ONLY },
    },
    (args) =>
      respond(async () => {
        const { domain } = parseInput(freeAuditSchema, args, "seo_free_audit");
        return seo.freeAudit(domain);
      }),
  );

  server.registerTool(
    "seo_check",
    {
      title: "SEOBolt focused checker",
      description: seoCheckDescription(),
      inputSchema: seoCheckShape,
      annotations: { title: "SEOBolt focused checker", ...READ_ONLY },
    },
    (args) =>
      respond(async () => {
        const request = parseInput(seoCheckSchema, args, "seo_check");
        return seo.check(request);
      }),
  );

  server.registerTool(
    "mrr_leaderboard",
    {
      title: "ShowMRR leaderboard",
      description:
        "List startups on the ShowMRR public leaderboard ranked by monthly recurring revenue (queries showmrr.com). Optional category filter. Money is returned in cents plus currency. Each row says whether its figure is verified; 'NOT verified' figures must never be presented as verified revenue. Use mrr_stats to see categories first.",
      inputSchema: leaderboardShape,
      annotations: { title: "ShowMRR leaderboard", ...READ_ONLY },
    },
    (args) => respond(() => mrr.leaderboard(args)),
  );

  server.registerTool(
    "mrr_search",
    {
      title: "ShowMRR search",
      description:
        "Search ShowMRR by startup name or keyword (sends the query to showmrr.com). Use it to look up a company's listed MRR when a founder or document claims a revenue number. No match only means the company is not listed, not that the claim is false. Results state whether each figure is verified.",
      inputSchema: searchShape,
      annotations: { title: "ShowMRR search", ...READ_ONLY },
    },
    (args) => respond(() => mrr.search(args.query)),
  );

  server.registerTool(
    "mrr_stats",
    {
      title: "ShowMRR aggregate stats",
      description:
        "Aggregate ShowMRR numbers: listing counts, verified count, total listed MRR and per-category totals (queries showmrr.com). Use it to get valid category slugs for mrr_leaderboard or the size of the dataset before drawing conclusions. The total includes unverified figures.",
      inputSchema: {},
      annotations: { title: "ShowMRR aggregate stats", ...READ_ONLY },
    },
    () => respond(() => mrr.stats()),
  );

  server.registerTool(
    "mrr_startup",
    {
      title: "ShowMRR startup detail",
      description:
        "Fetch one ShowMRR startup by numeric id or slug (queries showmrr.com): MRR in cents plus currency, verification flag, revenue-as-of date, and for unclaimed listings the public page the figure was read from. Use it to check a specific company after mrr_search finds its slug. Never present a 'NOT verified' figure as verified revenue.",
      inputSchema: startupShape,
      annotations: { title: "ShowMRR startup detail", ...READ_ONLY },
    },
    (args) => respond(() => mrr.startup(args.idOrSlug)),
  );

  server.registerTool(
    "email_auth_check",
    {
      title: "Email authentication check (SPF, DKIM, DMARC, MX)",
      description:
        "Check a sending domain's SPF, DMARC, DKIM and MX records with local DNS lookups (nothing is sent to any third-party service; DNS queries go through this machine's resolver). Use it when mail lands in spam, before launching a sending domain, or to produce exact DNS fixes. Pass dkimSelectors (the s= value from a real message's DKIM-Signature header) for a definitive DKIM answer; without them only common selectors are probed, which cannot prove DKIM is absent. No rate limit beyond your resolver's.",
      inputSchema: emailAuthShape,
      annotations: { title: "Email authentication check", ...READ_ONLY, openWorldHint: false },
    },
    (args) =>
      respond(async () => {
        const input = parseInput(emailAuthSchema, args, "email_auth_check");
        return shapeEmailAuth(await runEmailAuthCheck(resolver, input));
      }),
  );

  return server;
}
