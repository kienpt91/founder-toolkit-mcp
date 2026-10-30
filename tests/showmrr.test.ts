import { describe, expect, it } from "vitest";
import { RateLimitError, ToolkitError } from "../src/errors.js";
import { formatMoney, leaderboardShape, ShowMrrClient, startupShape, VERIFICATION_NOTICE } from "../src/showmrr.js";
import { z } from "zod";
import { fakeFetch, jsonResponse } from "./helpers.js";

const ghost = {
  rank: 1,
  startupId: 114,
  name: "Ghost",
  slug: "ghost",
  logoUrl: null,
  category: "content-creation",
  currentMrrCents: 93039800,
  mrrGrowthPct: 0,
  isVerified: false,
  founderName: "Unclaimed listing",
  revenueAsOf: "2026-10-30T01:42:36.908573Z",
  mrrCurrency: "usd",
  tagline: "Open-source publishing platform",
  websiteUrl: "https://ghost.org",
  sparklineData: [1, 2, 3],
};
const verified = { ...ghost, rank: 2, startupId: 7, name: "Acme", slug: "acme", currentMrrCents: 123456, isVerified: true, founderName: "A. Founder" };

describe("formatMoney", () => {
  it("formats cents with grouping and an explicit currency code", () => {
    expect(formatMoney(93039800, "usd")).toBe("930,398.00 USD");
    expect(formatMoney(5, "eur")).toBe("0.05 EUR");
    expect(formatMoney(0, undefined)).toBe("0.00 USD");
    expect(formatMoney(-150, "gbp")).toBe("-1.50 GBP");
    expect(formatMoney(undefined, "usd")).toBe("n/a");
  });
});

describe("ShowMrrClient", () => {
  it("GETs /stats and shapes totals, keeping the verification notice", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({
        startupCount: 17,
        totalMrrCents: 98041900,
        verifiedCount: 0,
        founderCount: 13,
        revenueDistribution: [{ bracket: "0", count: 14 }],
        categories: [{ category: "saas", count: 6, totalMrrCents: 0, avgMrrCents: 0 }],
      }),
    );
    const out = await new ShowMrrClient(fetch).stats();
    expect(calls[0]?.url).toBe("https://showmrr.com/api/stats");
    expect(calls[0]?.method).toBe("GET");
    expect(out.summary).toContain("17 startups");
    expect(out.summary).toContain("includes unverified");
    expect(out.data.notice).toBe(VERIFICATION_NOTICE);
    expect((out.data.totalMrr as { formatted: string }).formatted).toBe("980,419.00 USD");
  });

  it("GETs the leaderboard with limit and optional category", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ data: [ghost, verified] }));
    const client = new ShowMrrClient(fetch);
    await client.leaderboard({ limit: 5 });
    await client.leaderboard({ limit: 3, category: "analytics" });
    expect(calls[0]?.url).toBe("https://showmrr.com/api/leaderboard?limit=5");
    expect(calls[1]?.url).toBe("https://showmrr.com/api/leaderboard?limit=3&category=analytics");
  });

  it("labels unverified figures as NOT verified and verified ones as verified", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ data: [ghost, verified] }));
    const out = await new ShowMrrClient(fetch).leaderboard({ limit: 10 });
    const rows = out.data.startups as { name: string; verification: string; isVerified: boolean; mrr: { amountCents: number; currency: string; formatted: string }; sparklineData?: unknown }[];
    expect(rows[0]).toMatchObject({ name: "Ghost", verification: "NOT verified", isVerified: false });
    expect(rows[1]).toMatchObject({ name: "Acme", verification: "verified", isVerified: true });
    expect(rows[0]?.mrr).toEqual({ amountCents: 93039800, currency: "usd", formatted: "930,398.00 USD" });
    expect(rows[0]).not.toHaveProperty("sparklineData");
    expect(out.summary).toContain("1 NOT verified");
    expect(out.summary).toContain("(NOT verified)");
    expect(out.data.notice).toBe(VERIFICATION_NOTICE);
  });

  it("treats a missing isVerified flag as NOT verified", async () => {
    const { isVerified: _drop, ...noFlag } = ghost;
    const { fetch } = fakeFetch(() => jsonResponse({ data: [noFlag] }));
    const out = await new ShowMrrClient(fetch).leaderboard({ limit: 1 });
    expect((out.data.startups as { verification: string }[])[0]?.verification).toBe("NOT verified");
  });

  it("URL-encodes the search query and reports no match honestly", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ data: [] }));
    const out = await new ShowMrrClient(fetch).search("a b&c=d");
    expect(calls[0]?.url).toBe("https://showmrr.com/api/search?q=a+b%26c%3Dd");
    expect(out.data.count).toBe(0);
    expect(out.summary).toContain("proves nothing");
  });

  it("shapes search matches", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ data: [verified] }));
    const out = await new ShowMrrClient(fetch).search("acme");
    expect(out.summary).toContain("1 match");
    expect(out.summary).toContain("Acme");
  });

  it("fetches a startup by slug, keeping publicSource and claimable", async () => {
    const detail = { ...ghost, id: 114, claimable: true, publicSource: { url: "https://ghost.org/about/", metric: "monthly_revenue", readAt: "2026-10-30T01:42:36Z" } };
    const { fetch, calls } = fakeFetch(() => jsonResponse(detail));
    const out = await new ShowMrrClient(fetch).startup("ghost");
    expect(calls[0]?.url).toBe("https://showmrr.com/api/startups/ghost");
    const s = out.data.startup as { claimable: boolean; publicSource: { url: string }; verification: string };
    expect(s.claimable).toBe(true);
    expect(s.publicSource.url).toBe("https://ghost.org/about/");
    expect(s.verification).toBe("NOT verified");
    expect(out.summary).toContain("NOT verified");
  });

  it("encodes path segments", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(ghost));
    await new ShowMrrClient(fetch).startup("a/b");
    expect(calls[0]?.url).toBe("https://showmrr.com/api/startups/a%2Fb");
  });

  it("maps a 404 to a clear rejection", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Startup not found" }, 404));
    await expect(new ShowMrrClient(fetch).startup("nope")).rejects.toThrowError(/HTTP 404.*Startup not found/);
  });

  it("maps 429 and 5xx", async () => {
    const limited = fakeFetch(() => jsonResponse({ error: "slow down" }, 429, { "retry-after": "60" }));
    await expect(new ShowMrrClient(limited.fetch).stats()).rejects.toBeInstanceOf(RateLimitError);
    const broken = fakeFetch(() => jsonResponse({ error: "Internal server error" }, 500));
    await expect(new ShowMrrClient(broken.fetch).stats()).rejects.toThrowError(/HTTP 500/);
  });

  it("rejects unexpected response shapes", async () => {
    const odd = fakeFetch(() => jsonResponse({ nope: true }));
    await expect(new ShowMrrClient(odd.fetch).leaderboard({ limit: 1 })).rejects.toBeInstanceOf(ToolkitError);
    await expect(new ShowMrrClient(odd.fetch).stats()).rejects.toThrowError(/unexpected/);
  });
});

describe("input schemas", () => {
  const leaderboard = z.object(leaderboardShape);
  const startup = z.object(startupShape);

  it("defaults and bounds the leaderboard limit", () => {
    expect(leaderboard.parse({}).limit).toBe(10);
    expect(leaderboard.safeParse({ limit: 0 }).success).toBe(false);
    expect(leaderboard.safeParse({ limit: 51 }).success).toBe(false);
    expect(leaderboard.safeParse({ limit: 2.5 }).success).toBe(false);
    expect(leaderboard.safeParse({ limit: 5, category: "Bad Category" }).success).toBe(false);
  });

  it("accepts ids and slugs but not path tricks", () => {
    expect(startup.safeParse({ idOrSlug: "114" }).success).toBe(true);
    expect(startup.safeParse({ idOrSlug: "simple-analytics" }).success).toBe(true);
    expect(startup.safeParse({ idOrSlug: "../stats" }).success).toBe(false);
    expect(startup.safeParse({ idOrSlug: "" }).success).toBe(false);
  });
});
