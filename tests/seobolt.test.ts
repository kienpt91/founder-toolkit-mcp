import { describe, expect, it } from "vitest";
import { RateLimitError, ToolkitError } from "../src/errors.js";
import {
  freeAuditSchema,
  SEO_CHECKS,
  SEO_SLUGS,
  SeoBoltClient,
  seoCheckSchema,
  shapeSeoCheck,
} from "../src/seobolt.js";
import { fakeFetch, jsonResponse } from "./helpers.js";

const llmsFixture = {
  tool: "llms-txt-checker",
  target: "https://example.com/llms.txt",
  domain: "example.com",
  verdict: { status: "fail", text: "No llms.txt found (HTTP 404)" },
  summary: { pass: 0, warn: 0, fail: 1, info: 1 },
  checks: [
    { id: "reachable", label: "llms.txt exists", status: "fail", detail: "answered HTTP 404", fix: "Create the file." },
    { id: "llms-full", label: "llms-full.txt (optional)", status: "info", detail: "not found" },
  ],
  sections: [{ kind: "code", title: "Minimal llms.txt", text: "# example.com\n" + "x".repeat(3000) }],
};

const auditFixture = {
  domain: "example.com",
  score: 23,
  seoScore: 32,
  llmScore: 67,
  checkedAt: "2026-10-30T08:37:56.570Z",
  reportUrl: "https://seobolt.app/free-audit/report/example.com",
  recommendations: [
    { id: "no-llms-txt", priority: "low", category: "AI", status: "warn", title: "No llms.txt", description: "d", howToFix: "h" },
    { id: "no-sitemap", priority: "critical", category: "Technical SEO", status: "fail", title: "Missing sitemap.xml", description: "d", howToFix: "h" },
    { id: "no-robots", priority: "high", category: "Technical SEO", status: "fail", title: "Missing robots.txt", description: "d", howToFix: "h" },
  ],
};

describe("seo_check input validation", () => {
  it("exposes only verified slugs and not ai-visibility-checker", () => {
    expect(SEO_SLUGS).toHaveLength(12);
    expect(SEO_SLUGS).not.toContain("ai-visibility-checker");
  });

  it("sends {domain} for domain checkers and reduces URLs to the host", () => {
    const r = seoCheckSchema.parse({ tool: "llms-txt-checker", target: "https://Example.com/some/page" });
    expect(r).toEqual({ slug: "llms-txt-checker", body: { domain: "example.com" } });
  });

  it("sends {url} for page checkers and promotes bare domains", () => {
    expect(seoCheckSchema.parse({ tool: "meta-tag-checker", target: "example.com" }).body).toEqual({ url: "https://example.com/" });
    expect(seoCheckSchema.parse({ tool: "heading-structure-checker", target: "https://example.com/a?b=1" }).body).toEqual({
      url: "https://example.com/a?b=1",
    });
  });

  it("maps each slug to the input kind observed on the live endpoints", () => {
    const urlSlugs = SEO_SLUGS.filter((s) => SEO_CHECKS[s].input === "url").sort();
    expect(urlSlugs).toEqual(
      [
        "ai-citation-readiness-checker",
        "broken-link-checker",
        "heading-structure-checker",
        "indexability-checker",
        "meta-tag-checker",
        "redirect-checker",
        "structured-data-checker",
      ].sort(),
    );
  });

  it("rejects unknown slugs, private hosts and empty targets", () => {
    expect(seoCheckSchema.safeParse({ tool: "ai-visibility-checker", target: "example.com" }).success).toBe(false);
    const priv = seoCheckSchema.safeParse({ tool: "sitemap-checker", target: "localhost" });
    expect(priv.success).toBe(false);
    expect(seoCheckSchema.safeParse({ tool: "sitemap-checker", target: "" }).success).toBe(false);
  });

  it("allows bots/paths only for robots-txt-tester", () => {
    const ok = seoCheckSchema.parse({ tool: "robots-txt-tester", target: "example.com", bots: ["Bingbot"], paths: ["/a", "/b"] });
    expect(ok.body).toEqual({ domain: "example.com", bots: ["Bingbot"], paths: ["/a", "/b"] });
    expect(seoCheckSchema.safeParse({ tool: "sitemap-checker", target: "example.com", bots: ["Bingbot"] }).success).toBe(false);
    expect(seoCheckSchema.safeParse({ tool: "robots-txt-tester", target: "example.com", paths: ["no-slash"] }).success).toBe(false);
    expect(seoCheckSchema.safeParse({ tool: "robots-txt-tester", target: "example.com", bots: ["bad bot!"] }).success).toBe(false);
  });

  it("validates the free audit domain", () => {
    expect(freeAuditSchema.parse({ domain: "https://www.example.com/x" })).toEqual({ domain: "www.example.com" });
    expect(freeAuditSchema.safeParse({ domain: "10.0.0.1" }).success).toBe(false);
  });
});

describe("SeoBoltClient", () => {
  it("POSTs the free audit to /api/free-audit and orders recommendations by priority", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(auditFixture));
    const out = await new SeoBoltClient(fetch).freeAudit("example.com");
    expect(calls[0]?.url).toBe("https://seobolt.app/api/free-audit");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ domain: "example.com" });
    const recs = out.data.recommendations as { id: string }[];
    expect(recs.map((r) => r.id)).toEqual(["no-sitemap", "no-robots", "no-llms-txt"]);
    expect(out.data.recommendationCounts).toEqual({ critical: 1, high: 1, low: 1 });
    expect(out.summary).toContain("score 23");
    expect(out.summary).toContain("3 recommendations");
  });

  it("caps very long recommendation lists and says so", async () => {
    const many = { ...auditFixture, recommendations: Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, priority: "low", title: "t", description: "d", howToFix: "h" })) };
    const { fetch } = fakeFetch(() => jsonResponse(many));
    const out = await new SeoBoltClient(fetch).freeAudit("example.com");
    expect((out.data.recommendations as unknown[]).length).toBe(25);
    expect(out.data.recommendationsOmitted).toBe(15);
  });

  it("POSTs checkers to /api/tools/<slug> with the validated body", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(llmsFixture));
    const request = seoCheckSchema.parse({ tool: "llms-txt-checker", target: "example.com" });
    const out = await new SeoBoltClient(fetch).check(request);
    expect(calls[0]?.url).toBe("https://seobolt.app/api/tools/llms-txt-checker");
    expect(calls[0]?.body).toEqual({ domain: "example.com" });
    expect(out.summary).toContain("FAIL");
    expect(out.summary).toContain("No llms.txt found");
  });

  it("trims oversized code sections", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(llmsFixture));
    const request = seoCheckSchema.parse({ tool: "llms-txt-checker", target: "example.com" });
    const out = await new SeoBoltClient(fetch).check(request);
    const section = (out.data.sections as { text: string }[])[0];
    expect(section?.text.length).toBeLessThan(1600);
    expect(section?.text).toContain("[truncated]");
  });

  it("caps table rows", () => {
    const rows = Array.from({ length: 40 }, (_, i) => [`https://e.com/${i}`, "200", ""]);
    const shaped = shapeSeoCheck("broken-link-checker", {
      ...llmsFixture,
      tool: "broken-link-checker",
      sections: [{ kind: "table", title: "links", columns: ["Link", "Result", "Detail"], rows }],
    });
    const table = (shaped.data.sections as { rows: unknown[]; rowsOmitted: number }[])[0];
    expect(table?.rows).toHaveLength(15);
    expect(table?.rowsOmitted).toBe(25);
  });

  it("normalizes meta-tag-checker, which has a different response shape", () => {
    const shaped = shapeSeoCheck("meta-tag-checker", {
      checkedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      status: 200,
      tags: { title: "Example Domain", description: "" },
      lengths: { title: { count: 14, status: "short" } },
      issues: ["Title tag is short", "Missing meta description", "Missing canonical link", "Missing og:title"],
    });
    expect(shaped.data.target).toBe("https://example.com/");
    expect(shaped.data.httpStatus).toBe(200);
    expect(shaped.summary).toContain("4 issue(s)");
  });

  it("normalizes robots-txt-tester and counts blocked pairs", () => {
    const shaped = shapeSeoCheck("robots-txt-tester", {
      robotsUrl: "https://example.com/robots.txt",
      status: 200,
      found: true,
      groups: [],
      sitemaps: ["https://example.com/sitemap.xml"],
      tests: [
        { bot: "Bingbot", path: "/a", allowed: false, matchedRule: "Disallow: /" },
        { bot: "Bingbot", path: "/b", allowed: true, matchedRule: null },
      ],
      robotsTxt: "User-agent: Bingbot\nDisallow: /",
    });
    expect(shaped.summary).toContain("1 of 2");
    expect((shaped.data.tests as { allowed: boolean }[]).map((t) => t.allowed)).toEqual([false, true]);
  });

  it("sends robots bots/paths in the request body", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ robotsUrl: "u", status: 404, found: false, groups: [], sitemaps: [], tests: [], robotsTxt: "" }));
    const request = seoCheckSchema.parse({ tool: "robots-txt-tester", target: "example.com", bots: ["Googlebot"], paths: ["/x"] });
    await new SeoBoltClient(fetch).check(request);
    expect(calls[0]?.body).toEqual({ domain: "example.com", bots: ["Googlebot"], paths: ["/x"] });
  });

  it("rejects an unexpected response shape instead of guessing", () => {
    expect(() => shapeSeoCheck("sitemap-checker", { hello: "world" })).toThrowError(ToolkitError);
    expect(() => shapeSeoCheck("sitemap-checker", "nope")).toThrowError(/unexpected/);
  });

  it("maps 429 to a RateLimitError naming SEOBolt", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Too many requests. Please try again later." }, 429, { "retry-after": "300", "x-ratelimit-limit": "3" }));
    const request = seoCheckSchema.parse({ tool: "llms-txt-checker", target: "example.com" });
    const err = await new SeoBoltClient(fetch).check(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).message).toContain("SEOBolt rate limit");
  });

  it("surfaces service-side 400s and 5xx distinctly", async () => {
    const bad = fakeFetch(() => jsonResponse({ error: "Enter a valid public domain (e.g. example.com)" }, 400));
    const request = seoCheckSchema.parse({ tool: "sitemap-checker", target: "example.com" });
    await expect(new SeoBoltClient(bad.fetch).check(request)).rejects.toThrowError(/HTTP 400.*valid public domain/);
    const down = fakeFetch(() => jsonResponse({ error: "boom" }, 503));
    await expect(new SeoBoltClient(down.fetch).freeAudit("example.com")).rejects.toThrowError(/HTTP 503/);
  });

  it("applies the configured timeout", async () => {
    const hanging = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(new SeoBoltClient(hanging, 20).freeAudit("example.com")).rejects.toThrowError(/did not answer/);
  });
});
