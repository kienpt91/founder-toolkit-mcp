import { z } from "zod";
import { ToolkitError } from "./errors.js";
import { requestJson, type FetchLike } from "./http.js";
import { clip, isRecord, num, str } from "./text.js";
import { normalizeDomain, normalizeUrl } from "./validate.js";

export const SEOBOLT_BASE = "https://seobolt.app";
export const SEOBOLT_TIMEOUT_MS = 45_000;
const SERVICE = "SEOBolt";

export type InputKind = "domain" | "url";

export interface SeoCheckInfo {
  input: InputKind;
  purpose: string;
}

/**
 * Only checkers that returned a valid response when probed are listed.
 * `ai-visibility-checker` has a page on the site but its API route answered HTTP 404, so it is not exposed.
 */
export const SEO_CHECKS = {
  "llms-txt-checker": { input: "domain", purpose: "Is there a valid /llms.txt (and optional llms-full.txt)?" },
  "ai-crawler-access-checker": {
    input: "domain",
    purpose: "Does robots.txt let AI search and user-request crawlers reach the site?",
  },
  "chatgpt-visibility-checker": {
    input: "domain",
    purpose: "Can ChatGPT's crawlers reach the site, plus on-page signals for being cited?",
  },
  "ai-citation-readiness-checker": {
    input: "url",
    purpose: "Does a page carry the signals answer engines use to quote it (12 signals)?",
  },
  "redirect-checker": { input: "url", purpose: "Follow the redirect chain of a URL and flag loops, long chains, http->https." },
  "indexability-checker": {
    input: "url",
    purpose: "Can search engines index the page (status, noindex, X-Robots-Tag, canonical)?",
  },
  "sitemap-checker": { input: "domain", purpose: "Find and validate the XML sitemap." },
  "structured-data-checker": { input: "url", purpose: "Find and validate JSON-LD structured data on a page." },
  "heading-structure-checker": { input: "url", purpose: "Check H1 count and heading hierarchy on a page." },
  "broken-link-checker": { input: "url", purpose: "Check links found in the page's served HTML for broken or redirecting targets." },
  "meta-tag-checker": { input: "url", purpose: "Title, description, canonical, Open Graph and Twitter tags with length checks." },
  "robots-txt-tester": {
    input: "domain",
    purpose: "Fetch robots.txt and test whether named bots may crawl given paths (optional bots and paths).",
  },
} as const satisfies Record<string, SeoCheckInfo>;

export type SeoSlug = keyof typeof SEO_CHECKS;
export const SEO_SLUGS = Object.keys(SEO_CHECKS) as [SeoSlug, ...SeoSlug[]];

const botName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9._-]+$/, "bot names may only contain letters, digits, '.', '_' and '-'");
const robotsPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\//, "paths must start with '/'");

export const seoCheckShape = {
  tool: z.enum(SEO_SLUGS).describe("Which SEOBolt checker to run."),
  target: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      "Domain (example.com) for domain checkers, or full page URL (https://example.com/page) for URL checkers. A URL is reduced to its host for domain checkers; a bare domain becomes https://<domain>/ for URL checkers.",
    ),
  bots: z.array(botName).max(10).optional().describe("robots-txt-tester only: user-agent names to test."),
  paths: z.array(robotsPath).max(20).optional().describe("robots-txt-tester only: paths to test, each starting with '/'."),
};

export interface SeoCheckRequest {
  slug: SeoSlug;
  body: Record<string, unknown>;
}

/** Validates per slug and produces the exact JSON body the endpoint expects. */
export const seoCheckSchema = z.object(seoCheckShape).transform((input, ctx): SeoCheckRequest => {
  const info: SeoCheckInfo = SEO_CHECKS[input.tool];
  const body: Record<string, unknown> = {};
  try {
    if (info.input === "domain") body.domain = normalizeDomain(input.target);
    else body.url = normalizeUrl(input.target);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target"],
      message: err instanceof Error ? err.message : "invalid target",
    });
    return z.NEVER;
  }
  if (input.tool === "robots-txt-tester") {
    if (input.bots?.length) body.bots = input.bots;
    if (input.paths?.length) body.paths = input.paths;
  } else if (input.bots || input.paths) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [input.bots ? "bots" : "paths"],
      message: "bots and paths are only supported by robots-txt-tester",
    });
    return z.NEVER;
  }
  return { slug: input.tool, body };
});

export const freeAuditShape = {
  domain: z.string().min(1).max(2048).describe("Public domain to audit, e.g. example.com (a URL is reduced to its host)."),
};
export const freeAuditSchema = z.object(freeAuditShape).transform((input, ctx) => {
  try {
    return { domain: normalizeDomain(input.domain) };
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["domain"],
      message: err instanceof Error ? err.message : "invalid domain",
    });
    return z.NEVER;
  }
});

export interface Shaped {
  summary: string;
  data: Record<string, unknown>;
}

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const MAX_RECOMMENDATIONS = 25;

function unexpected(what: string): never {
  throw new ToolkitError("invalid_response", `${SERVICE} returned an unexpected ${what} shape. The endpoint may have changed.`);
}

export function shapeFreeAudit(raw: unknown): Shaped {
  if (!isRecord(raw) || !Array.isArray(raw.recommendations)) unexpected("free-audit");
  const recs = raw.recommendations
    .filter(isRecord)
    .map((r) => ({
      id: str(r.id),
      priority: str(r.priority),
      category: str(r.category),
      status: str(r.status),
      title: clip(str(r.title) ?? "", 200),
      description: clip(str(r.description) ?? "", 500),
      howToFix: clip(str(r.howToFix) ?? "", 800),
    }))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (PRIORITY_ORDER[a.r.priority ?? ""] ?? 9) - (PRIORITY_ORDER[b.r.priority ?? ""] ?? 9) || a.i - b.i)
    .map(({ r }) => r);
  const counts: Record<string, number> = {};
  for (const r of recs) counts[r.priority ?? "unknown"] = (counts[r.priority ?? "unknown"] ?? 0) + 1;
  const domain = str(raw.domain) ?? "unknown domain";
  const data = {
    domain,
    score: num(raw.score),
    seoScore: num(raw.seoScore),
    llmScore: num(raw.llmScore),
    checkedAt: str(raw.checkedAt),
    reportUrl: str(raw.reportUrl),
    recommendationCounts: counts,
    recommendations: recs.slice(0, MAX_RECOMMENDATIONS),
    ...(recs.length > MAX_RECOMMENDATIONS ? { recommendationsOmitted: recs.length - MAX_RECOMMENDATIONS } : {}),
  };
  const countText = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  return {
    summary: `SEOBolt free audit for ${domain}: score ${data.score ?? "n/a"} (seo ${data.seoScore ?? "n/a"}, llm ${data.llmScore ?? "n/a"}); ${recs.length} recommendations${countText ? ` (${countText})` : ""}.`,
    data,
  };
}

const MAX_SECTIONS = 6;
const MAX_TABLE_ROWS = 15;

function shapeSection(section: unknown): Record<string, unknown> | undefined {
  if (!isRecord(section)) return undefined;
  const kind = str(section.kind) ?? "unknown";
  const title = str(section.title) ?? "";
  if (kind === "code") return { kind, title: clip(title, 200), text: clip(str(section.text) ?? "", 1500) };
  if (kind === "table") {
    const rows = Array.isArray(section.rows) ? section.rows : [];
    return {
      kind,
      title: clip(title, 200),
      columns: Array.isArray(section.columns) ? section.columns.filter((c) => typeof c === "string").slice(0, 8) : [],
      rows: rows.slice(0, MAX_TABLE_ROWS).map((row) =>
        Array.isArray(row) ? row.map((cell) => (typeof cell === "string" ? clip(cell, 200) : cell)) : row,
      ),
      ...(rows.length > MAX_TABLE_ROWS ? { rowsOmitted: rows.length - MAX_TABLE_ROWS } : {}),
    };
  }
  return { kind, title: clip(title, 200) };
}

function shapeStandard(slug: SeoSlug, raw: Record<string, unknown>): Shaped {
  const verdict = isRecord(raw.verdict) ? raw.verdict : {};
  const counts = isRecord(raw.summary) ? raw.summary : {};
  const checks = (raw.checks as unknown[]).filter(isRecord).map((c) => ({
    id: str(c.id),
    label: clip(str(c.label) ?? "", 200),
    status: str(c.status),
    detail: c.detail === undefined ? undefined : clip(str(c.detail) ?? "", 500),
    fix: c.fix === undefined ? undefined : clip(str(c.fix) ?? "", 600),
  }));
  const sections = Array.isArray(raw.sections)
    ? raw.sections.map(shapeSection).filter((s): s is Record<string, unknown> => s !== undefined)
    : [];
  const status = str(verdict.status) ?? "unknown";
  const target = str(raw.target) ?? "unknown target";
  const data = {
    tool: slug,
    target,
    domain: str(raw.domain),
    verdict: { status, text: clip(str(verdict.text) ?? "", 300) },
    counts: { pass: num(counts.pass) ?? 0, warn: num(counts.warn) ?? 0, fail: num(counts.fail) ?? 0, info: num(counts.info) ?? 0 },
    checks,
    sections: sections.slice(0, MAX_SECTIONS),
    ...(sections.length > MAX_SECTIONS ? { sectionsOmitted: sections.length - MAX_SECTIONS } : {}),
  };
  return {
    summary: `${slug} on ${target}: ${status.toUpperCase()} - ${data.verdict.text} (pass ${data.counts.pass}, warn ${data.counts.warn}, fail ${data.counts.fail}).`,
    data,
  };
}

function shapeMeta(raw: Record<string, unknown>): Shaped {
  const issues = Array.isArray(raw.issues) ? raw.issues.filter((i): i is string => typeof i === "string").slice(0, 30) : [];
  const target = str(raw.checkedUrl) ?? "unknown target";
  const data = {
    tool: "meta-tag-checker",
    target,
    finalUrl: str(raw.finalUrl),
    httpStatus: num(raw.status),
    tags: raw.tags,
    lengths: raw.lengths,
    issues,
  };
  return {
    summary: `meta-tag-checker on ${target}: ${issues.length === 0 ? "no issues found" : `${issues.length} issue(s), e.g. ${issues.slice(0, 3).join("; ")}`}.`,
    data,
  };
}

const MAX_ROBOTS_TESTS = 60;

function shapeRobots(raw: Record<string, unknown>): Shaped {
  const tests = Array.isArray(raw.tests) ? raw.tests.filter(isRecord) : [];
  const blocked = tests.filter((t) => t.allowed === false).length;
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  const robotsUrl = str(raw.robotsUrl) ?? "unknown robots.txt";
  const found = raw.found === true;
  const data = {
    tool: "robots-txt-tester",
    target: robotsUrl,
    httpStatus: num(raw.status),
    found,
    warning: str(raw.warning),
    sitemaps: Array.isArray(raw.sitemaps) ? raw.sitemaps.slice(0, 20) : [],
    groups: groups.slice(0, 30),
    ...(groups.length > 30 ? { groupsOmitted: groups.length - 30 } : {}),
    tests: tests.slice(0, MAX_ROBOTS_TESTS).map((t) => ({
      bot: str(t.bot),
      path: str(t.path),
      allowed: t.allowed === true,
      matchedRule: t.matchedRule ?? null,
    })),
    ...(tests.length > MAX_ROBOTS_TESTS ? { testsOmitted: tests.length - MAX_ROBOTS_TESTS } : {}),
    robotsTxt: clip(str(raw.robotsTxt) ?? "", 4000),
  };
  return {
    summary: `robots-txt-tester on ${robotsUrl}: ${found ? "robots.txt found" : "no robots.txt found"}; ${blocked} of ${tests.length} tested bot/path pairs blocked.`,
    data,
  };
}

export function shapeSeoCheck(slug: SeoSlug, raw: unknown): Shaped {
  if (!isRecord(raw)) unexpected(`${slug}`);
  if (slug === "meta-tag-checker") {
    if (!isRecord(raw.tags) || !Array.isArray(raw.issues)) unexpected(slug);
    return shapeMeta(raw);
  }
  if (slug === "robots-txt-tester") {
    if (!Array.isArray(raw.tests)) unexpected(slug);
    return shapeRobots(raw);
  }
  if (!Array.isArray(raw.checks) || !isRecord(raw.verdict)) unexpected(slug);
  return shapeStandard(slug, raw);
}

export class SeoBoltClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs: number = SEOBOLT_TIMEOUT_MS,
    private readonly base: string = SEOBOLT_BASE,
  ) {}

  async freeAudit(domain: string): Promise<Shaped> {
    const raw = await requestJson({
      service: SERVICE,
      fetch: this.fetchImpl,
      url: `${this.base}/api/free-audit`,
      method: "POST",
      body: { domain },
      timeoutMs: this.timeoutMs,
    });
    return shapeFreeAudit(raw);
  }

  async check(request: SeoCheckRequest): Promise<Shaped> {
    const raw = await requestJson({
      service: SERVICE,
      fetch: this.fetchImpl,
      url: `${this.base}/api/tools/${request.slug}`,
      method: "POST",
      body: request.body,
      timeoutMs: this.timeoutMs,
    });
    return shapeSeoCheck(request.slug, raw);
  }
}
