/**
 * Opt-in live smoke test: calls the REAL public endpoints through the real MCP server (in-memory transport).
 * Not part of `npm test`. Run with `npm run smoke:live`.
 *
 * Environment:
 *   SMOKE_DOMAIN   domain to analyse (default: example.com). Use a domain you may probe.
 *   SMOKE_PAUSE_MS pause between SEOBolt calls (default: 4000)
 *
 * Exit code is non-zero only for real failures. Rate limits are reported as RATE_LIMITED, not as failures,
 * because anonymous limits are a documented property of the free endpoints.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { SEO_CHECKS, SEO_SLUGS } from "../src/seobolt.js";

const domain = process.env.SMOKE_DOMAIN ?? "example.com";
const pauseMs = Number(process.env.SMOKE_PAUSE_MS ?? 4000);

type Outcome = "OK" | "RATE_LIMITED" | "FAIL";
interface Row {
  name: string;
  outcome: Outcome;
  ms: number;
  detail: string;
}
const rows: Row[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = createServer();
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: "smoke-live", version: "0.0.0" });
await client.connect(clientSide);

/** Strips the untrusted-data frame (header, begin and end markers) so the rest of the script sees summary + JSON. */
function unframe(text: string): string {
  const lines = text.split("\n");
  if (/^<<<UNTRUSTED-DATA [0-9a-f]+>>>$/.test(lines[1] ?? "") && /^<<<END-UNTRUSTED-DATA [0-9a-f]+>>>$/.test(lines[lines.length - 1] ?? "")) {
    return lines.slice(2, -1).join("\n");
  }
  return text;
}

async function call(label: string, name: string, args: Record<string, unknown>): Promise<string | undefined> {
  const started = Date.now();
  let outcome: Outcome = "OK";
  let text = "";
  try {
    const result = await client.callTool({ name, arguments: args });
    text = unframe((result.content as { text: string }[]).map((c) => c.text).join("\n"));
    if (result.isError) outcome = text.includes("rate_limited") ? "RATE_LIMITED" : "FAIL";
  } catch (err) {
    outcome = "FAIL";
    text = err instanceof Error ? err.message : String(err);
  }
  const detail = outcome === "OK" ? (text.split("\n")[0] ?? "") : text.split("\n")[0] ?? "";
  rows.push({ name: label, outcome, ms: Date.now() - started, detail });
  console.log(`${outcome.padEnd(13)} ${label.padEnd(44)} ${String(Date.now() - started).padStart(5)} ms  ${detail.slice(0, 160)}`);
  return outcome === "OK" ? text : undefined;
}

console.log(`Live smoke against real endpoints, target domain: ${domain}\n`);

await call("mrr_stats", "mrr_stats", {});
const board = await call("mrr_leaderboard limit=3", "mrr_leaderboard", { limit: 3 });
await call("mrr_search q=seo", "mrr_search", { query: "seo" });
let slug = "ghost";
if (board) {
  const parsed = JSON.parse(board.slice(board.indexOf("\n\n") + 2)) as { startups: { slug?: string }[] };
  slug = parsed.startups[0]?.slug ?? slug;
}
await call(`mrr_startup ${slug}`, "mrr_startup", { idOrSlug: slug });

await call(`email_auth_check ${domain}`, "email_auth_check", { domain });
await call("email_auth_check github.com", "email_auth_check", { domain: "github.com" });

await call("seo_free_audit", "seo_free_audit", { domain });
for (const slugName of SEO_SLUGS) {
  await sleep(pauseMs);
  const target = SEO_CHECKS[slugName].input === "url" ? `https://${domain}/` : domain;
  await call(`seo_check ${slugName}`, "seo_check", { tool: slugName, target });
}

await client.close();

const count = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
console.log(`\nSummary: ${count("OK")} ok, ${count("RATE_LIMITED")} rate-limited, ${count("FAIL")} failed, of ${rows.length} calls.`);
process.exit(count("FAIL") === 0 ? 0 : 1);
