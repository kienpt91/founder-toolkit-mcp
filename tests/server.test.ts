import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { VERSION } from "../src/version.js";
import { fakeFetch, fakeResolver, jsonResponse, type RecordedCall } from "./helpers.js";

const EXPECTED_TOOLS = [
  "email_auth_check",
  "mrr_leaderboard",
  "mrr_search",
  "mrr_startup",
  "mrr_stats",
  "seo_check",
  "seo_free_audit",
];

const clients: Client[] = [];

async function connect(opts: Parameters<typeof createServer>[0]): Promise<Client> {
  const server = createServer(opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join("\n");
}

function jsonOf(result: unknown): any {
  const text = textOf(result);
  return JSON.parse(text.slice(text.indexOf("\n\n") + 2));
}

const router = (calls: RecordedCall[]) => (call: RecordedCall): Response => {
  calls.push(call);
  if (call.url === "https://seobolt.app/api/free-audit") {
    return jsonResponse({ domain: "example.com", score: 40, seoScore: 50, llmScore: 30, recommendations: [{ id: "a", priority: "high", title: "T", description: "D", howToFix: "H" }] });
  }
  if (call.url.startsWith("https://seobolt.app/api/tools/")) {
    return jsonResponse({
      tool: "x",
      target: "https://example.com/",
      domain: "example.com",
      verdict: { status: "pass", text: "ok" },
      summary: { pass: 1, warn: 0, fail: 0, info: 0 },
      checks: [{ id: "c", label: "L", status: "pass", detail: "d" }],
    });
  }
  if (call.url.startsWith("https://showmrr.com/api/leaderboard")) {
    return jsonResponse({ data: [{ rank: 1, startupId: 1, name: "Ghost", slug: "ghost", currentMrrCents: 100, isVerified: false, mrrCurrency: "usd" }] });
  }
  if (call.url.startsWith("https://showmrr.com/api/search")) return jsonResponse({ data: [] });
  if (call.url === "https://showmrr.com/api/stats") return jsonResponse({ startupCount: 1, totalMrrCents: 100, verifiedCount: 0, founderCount: 1, categories: [] });
  if (call.url === "https://showmrr.com/api/startups/ghost") return jsonResponse({ id: 1, slug: "ghost", name: "Ghost", currentMrrCents: 100, isVerified: false, mrrCurrency: "usd" });
  return jsonResponse({ error: "not found" }, 404);
};

describe("MCP server end to end (in-memory transport, fake fetch and DNS)", () => {
  it("identifies itself and lists exactly the documented tools", async () => {
    const calls: RecordedCall[] = [];
    const client = await connect({ fetch: fakeFetch(router(calls)).fetch, resolver: fakeResolver({}).resolver });
    expect(client.getServerVersion()).toMatchObject({ name: "founder-toolkit-mcp", version: VERSION });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(client.getInstructions()).toContain("NOT verified");
  });

  it("gives every tool a useful description, read-only annotations and an object schema", async () => {
    const client = await connect({ fetch: fakeFetch(() => jsonResponse({})).fetch, resolver: fakeResolver({}).resolver });
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(80);
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.inputSchema.type).toBe("object");
    }
    const seoCheck = tools.find((t) => t.name === "seo_check");
    expect(seoCheck?.description).toContain("Rate limit");
    expect(seoCheck?.description).toContain("llms-txt-checker (domain)");
    expect(seoCheck?.description).toContain("meta-tag-checker (url)");
    expect(seoCheck?.description).not.toContain("ai-visibility-checker");
    const props = seoCheck?.inputSchema.properties as { tool: { enum: string[] } };
    expect(props.tool.enum).toHaveLength(12);
  });

  it("runs seo_free_audit through the fake fetch", async () => {
    const calls: RecordedCall[] = [];
    const client = await connect({ fetch: fakeFetch(router(calls)).fetch, resolver: fakeResolver({}).resolver });
    const result = await client.callTool({ name: "seo_free_audit", arguments: { domain: "https://Example.com/pricing" } });
    expect(result.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ url: "https://seobolt.app/api/free-audit", method: "POST", body: { domain: "example.com" } });
    expect(textOf(result)).toContain("SEOBolt free audit for example.com: score 40");
    expect(jsonOf(result).recommendations[0].id).toBe("a");
  });

  it("runs seo_check with a page URL for a url-type checker", async () => {
    const calls: RecordedCall[] = [];
    const client = await connect({ fetch: fakeFetch(router(calls)).fetch, resolver: fakeResolver({}).resolver });
    const result = await client.callTool({ name: "seo_check", arguments: { tool: "structured-data-checker", target: "https://example.com/blog/post" } });
    expect(result.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ url: "https://seobolt.app/api/tools/structured-data-checker", body: { url: "https://example.com/blog/post" } });
  });

  it("returns an isError result for invalid seo_check targets without calling the network", async () => {
    const calls: RecordedCall[] = [];
    const client = await connect({ fetch: fakeFetch(router(calls)).fetch, resolver: fakeResolver({}).resolver });
    const result = await client.callTool({ name: "seo_check", arguments: { tool: "sitemap-checker", target: "http://192.168.1.1/" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("invalid_input");
    expect(textOf(result)).toContain("IP addresses");
    expect(calls).toHaveLength(0);
  });

  it("rejects unknown checker names at the protocol layer", async () => {
    const calls: RecordedCall[] = [];
    const client = await connect({ fetch: fakeFetch(router(calls)).fetch, resolver: fakeResolver({}).resolver });
    const outcome = await client
      .callTool({ name: "seo_check", arguments: { tool: "ai-visibility-checker", target: "example.com" } })
      .then((r) => ({ isError: r.isError === true, text: textOf(r) }))
      .catch((e: Error) => ({ isError: true, text: e.message }));
    expect(outcome.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("translates a SEOBolt 429 into a clear, non-retry message", async () => {
    const client = await connect({
      fetch: fakeFetch(() => jsonResponse({ error: "Too many requests. Please try again later." }, 429, { "retry-after": "300", "x-ratelimit-limit": "3" })).fetch,
      resolver: fakeResolver({}).resolver,
    });
    const result = await client.callTool({ name: "seo_check", arguments: { tool: "llms-txt-checker", target: "example.com" } });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("rate_limited");
    expect(text).toContain("SEOBolt rate limit reached");
    expect(text).toContain("300 seconds");
    expect(text).toContain("do not retry in a loop");
  });

  it("reports 5xx, non-JSON and timeouts as errors, not crashes", async () => {
    const down = await connect({ fetch: fakeFetch(() => jsonResponse({ error: "x" }, 500)).fetch, resolver: fakeResolver({}).resolver });
    expect(textOf(await down.callTool({ name: "mrr_stats", arguments: {} }))).toContain("HTTP 500");
    const html = await connect({ fetch: fakeFetch(() => new Response("<html></html>", { status: 200 })).fetch, resolver: fakeResolver({}).resolver });
    expect(textOf(await html.callTool({ name: "mrr_stats", arguments: {} }))).toContain("not JSON");
    const hanging = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const slow = await connect({ fetch: hanging, resolver: fakeResolver({}).resolver, mrrTimeoutMs: 20 });
    const timedOut = await slow.callTool({ name: "mrr_stats", arguments: {} });
    expect(timedOut.isError).toBe(true);
    expect(textOf(timedOut)).toContain("timeout");
  });

  it("runs the ShowMRR tools and keeps the not-verified warning in every payload", async () => {
    const calls: RecordedCall[] = [];
    const client = await connect({ fetch: fakeFetch(router(calls)).fetch, resolver: fakeResolver({}).resolver });
    const board = await client.callTool({ name: "mrr_leaderboard", arguments: { limit: 3, category: "saas" } });
    expect(calls[0]?.url).toBe("https://showmrr.com/api/leaderboard?limit=3&category=saas");
    expect(jsonOf(board).startups[0]).toMatchObject({ name: "Ghost", verification: "NOT verified" });
    expect(jsonOf(board).notice).toContain("never present them as verified revenue");

    const search = await client.callTool({ name: "mrr_search", arguments: { query: "nothing" } });
    expect(jsonOf(search).count).toBe(0);

    const stats = await client.callTool({ name: "mrr_stats", arguments: {} });
    expect(textOf(stats)).toContain("ShowMRR: 1 startups");

    const one = await client.callTool({ name: "mrr_startup", arguments: { idOrSlug: "ghost" } });
    expect(jsonOf(one).startup.verification).toBe("NOT verified");
  });

  it("maps a ShowMRR 404 for an unknown startup to an error result", async () => {
    const client = await connect({ fetch: fakeFetch(router([])).fetch, resolver: fakeResolver({}).resolver });
    const result = await client.callTool({ name: "mrr_startup", arguments: { idOrSlug: "does-not-exist" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 404");
  });

  it("runs email_auth_check with the fake resolver and never touches fetch", async () => {
    const net = fakeFetch(() => jsonResponse({}));
    const { resolver, queries } = fakeResolver(
      {
        "example.com": ["v=spf1 -all"],
        "_dmarc.example.com": ["v=DMARC1; p=reject; rua=mailto:r@example.com"],
      },
      { "example.com": [{ exchange: "mx.example.net", priority: 10 }] },
    );
    const client = await connect({ fetch: net.fetch, resolver });
    const result = await client.callTool({ name: "email_auth_check", arguments: { domain: "example.com", dkimSelectors: ["s1"] } });
    expect(result.isError).toBeFalsy();
    const data = jsonOf(result);
    expect(data.spf.status).toBe("pass");
    expect(data.dmarc.policy).toBe("reject");
    expect(data.dkim.status).toBe("fail");
    expect(textOf(result)).toContain("Email auth for example.com: FAIL");
    expect(queries).toContain("TXT s1._domainkey.example.com");
    expect(net.calls).toHaveLength(0);
  });

  it("rejects an invalid email_auth_check domain", async () => {
    const client = await connect({ fetch: fakeFetch(() => jsonResponse({})).fetch, resolver: fakeResolver({}).resolver });
    const result = await client.callTool({ name: "email_auth_check", arguments: { domain: "localhost" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("invalid_input");
  });

  it("keeps tool output bounded", async () => {
    const huge = { tool: "x", target: "t", verdict: { status: "pass", text: "ok" }, summary: {}, checks: Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, label: "L".repeat(200), status: "pass", detail: "d".repeat(500) })) };
    const client = await connect({ fetch: fakeFetch(() => jsonResponse(huge)).fetch, resolver: fakeResolver({}).resolver });
    const result = await client.callTool({ name: "seo_check", arguments: { tool: "sitemap-checker", target: "example.com" } });
    expect(textOf(result).length).toBeLessThanOrEqual(40_100);
    expect(textOf(result)).toContain("[truncated]");
  });
});
