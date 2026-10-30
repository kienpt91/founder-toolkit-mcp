import { z } from "zod";
import { ToolkitError } from "./errors.js";
import { requestJson, type FetchLike } from "./http.js";
import { cleanText, httpUrlOrUndefined, isRecord, num, shaped, str, type Shaped } from "./text.js";

export const SHOWMRR_BASE = "https://showmrr.com/api";
export const SHOWMRR_TIMEOUT_MS = 15_000;
const SERVICE = "ShowMRR";

export const VERIFICATION_NOTICE =
  "Only figures marked verification=verified are verified revenue. Figures marked NOT verified are unverified (self-reported or read from a public page); never present them as verified revenue.";

export const leaderboardShape = {
  limit: z.number().int().min(1).max(50).default(10).describe("How many rows to return (1-50, default 10)."),
  category: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "category must be a lowercase slug such as saas")
    .optional()
    .describe("Optional category slug filter, e.g. saas or analytics. Use mrr_stats to list categories."),
};

export const searchShape = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^\p{C}]+$/u, "query must not contain control or invisible characters")
    .describe("Startup name or keyword to search for."),
};

export const startupShape = {
  idOrSlug: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, "use a numeric id or a slug such as ghost")
    .describe("ShowMRR numeric id or slug of the startup, e.g. ghost."),
};

export function formatMoney(cents: number | undefined, currency: string | undefined): string {
  if (cents === undefined) return "n/a";
  const code = (currency ?? "usd").toUpperCase();
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${minor} ${code}`;
}

function shapeStartup(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new ToolkitError("invalid_response", `${SERVICE} returned an unexpected startup entry.`);
  }
  const isVerified = raw.isVerified === true;
  const cents = num(raw.currentMrrCents);
  const reportedCurrency = str(raw.mrrCurrency);
  // A currency code is 3-6 letters; anything else is shown as "unknown" rather than echoed.
  const currency = reportedCurrency === undefined ? "usd" : /^[A-Za-z]{3,6}$/.test(reportedCurrency) ? reportedCurrency : "unknown";
  const source = isRecord(raw.publicSource)
    ? { url: httpUrlOrUndefined(raw.publicSource.url), metric: str(raw.publicSource.metric), readAt: str(raw.publicSource.readAt) }
    : undefined;
  return {
    id: num(raw.id) ?? num(raw.startupId),
    slug: typeof raw.slug === "string" ? cleanText(raw.slug, 100) : undefined,
    name: typeof raw.name === "string" ? cleanText(raw.name, 120) : undefined,
    category: str(raw.category),
    tagline: typeof raw.tagline === "string" ? cleanText(raw.tagline, 200) : undefined,
    websiteUrl: httpUrlOrUndefined(raw.websiteUrl),
    rank: num(raw.rank),
    mrr: { amountCents: cents, currency: currency.toLowerCase(), formatted: formatMoney(cents, currency) },
    verification: isVerified ? "verified" : "NOT verified",
    isVerified,
    founderName: typeof raw.founderName === "string" ? cleanText(raw.founderName, 120) : undefined,
    revenueAsOf: str(raw.revenueAsOf),
    ...(raw.claimable !== undefined ? { claimable: raw.claimable === true } : {}),
    ...(source ? { publicSource: source } : {}),
    ...(num(raw.customerCount) !== undefined ? { customerCount: num(raw.customerCount) } : {}),
  };
}

function rows(raw: unknown, what: string): unknown[] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new ToolkitError("invalid_response", `${SERVICE} returned an unexpected ${what} response shape.`);
  }
  return raw.data;
}

function describeRow(s: Record<string, unknown>): string {
  const mrr = s.mrr as { formatted: string };
  return `${s.rank !== undefined ? `${s.rank}. ` : ""}${s.name ?? s.slug} - ${mrr.formatted}/mo (${s.verification})`;
}

export class ShowMrrClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs: number = SHOWMRR_TIMEOUT_MS,
    private readonly base: string = SHOWMRR_BASE,
  ) {}

  private get(path: string): Promise<unknown> {
    return requestJson({ service: SERVICE, fetch: this.fetchImpl, url: `${this.base}${path}`, method: "GET", timeoutMs: this.timeoutMs });
  }

  async stats(): Promise<Shaped> {
    const raw = await this.get("/stats");
    if (!isRecord(raw) || num(raw.startupCount) === undefined) {
      throw new ToolkitError("invalid_response", `${SERVICE} returned an unexpected stats response shape.`);
    }
    const categories = Array.isArray(raw.categories) ? raw.categories.filter(isRecord) : [];
    const data = {
      startupCount: num(raw.startupCount),
      verifiedCount: num(raw.verifiedCount),
      founderCount: num(raw.founderCount),
      totalMrr: { amountCents: num(raw.totalMrrCents), formatted: formatMoney(num(raw.totalMrrCents), "usd"), note: "Sum over all listings including unverified ones; currency assumed usd." },
      revenueDistribution: raw.revenueDistribution,
      categories: categories.slice(0, 50).map((c) => ({
        category: str(c.category),
        count: num(c.count),
        totalMrrCents: num(c.totalMrrCents),
        avgMrrCents: num(c.avgMrrCents),
      })),
      notice: VERIFICATION_NOTICE,
    };
    return shaped(
      `ShowMRR: ${data.startupCount} startups, ${data.verifiedCount ?? "n/a"} verified; total listed MRR ${data.totalMrr.formatted} (includes unverified figures).`,
      data,
    );
  }

  async leaderboard(input: { limit: number; category?: string | undefined }): Promise<Shaped> {
    const params = new URLSearchParams({ limit: String(input.limit) });
    if (input.category) params.set("category", input.category);
    const startups = rows(await this.get(`/leaderboard?${params.toString()}`), "leaderboard")
      .map(shapeStartup)
      .slice(0, input.limit);
    const unverified = startups.filter((s) => s.isVerified !== true).length;
    return shaped(
      `ShowMRR leaderboard${input.category ? ` (${input.category})` : ""}: ${startups.length} row(s), ${unverified} NOT verified.${startups[0] ? ` Top: ${describeRow(startups[0])}.` : ""}`,
      { count: startups.length, category: input.category, startups, notice: VERIFICATION_NOTICE },
    );
  }

  async search(query: string): Promise<Shaped> {
    const params = new URLSearchParams({ q: query });
    const startups = rows(await this.get(`/search?${params.toString()}`), "search").map(shapeStartup).slice(0, 20);
    return shaped(
      startups.length === 0
        ? `ShowMRR search "${query}": no matching startups listed. Absence from ShowMRR proves nothing about the company's revenue.`
        : `ShowMRR search "${query}": ${startups.length} match(es). ${startups.slice(0, 3).map(describeRow).join("; ")}.`,
      { query, count: startups.length, startups, notice: VERIFICATION_NOTICE },
    );
  }

  async startup(idOrSlug: string): Promise<Shaped> {
    const raw = await this.get(`/startups/${encodeURIComponent(idOrSlug)}`);
    const startup = shapeStartup(raw);
    return shaped(
      `ShowMRR startup ${startup.name ?? idOrSlug}: ${(startup.mrr as { formatted: string }).formatted}/mo, ${startup.verification}.`,
      { startup, notice: VERIFICATION_NOTICE },
    );
  }
}
