# founder-toolkit-mcp

Free, no-API-key MCP server and portable agent skills for three jobs a founder keeps repeating: **auditing a site's SEO and AI-search readiness**, **checking a startup's revenue claim against ShowMRR**, and **checking SPF/DKIM/DMARC records**.

It is a stdio server written in TypeScript on the official `@modelcontextprotocol/sdk`. Seven tools, four skills, no account, no key.

## Disclosure: who runs the services behind these tools

I (Kien Phan, [@kienpt91](https://github.com/kienpt91)) operate the three products this toolkit talks to:

| Product | Site | Used for |
| --- | --- | --- |
| SEOBolt | [seobolt.app](https://seobolt.app) | `seo_free_audit`, `seo_check` |
| ShowMRR | [showmrr.com](https://showmrr.com) | `mrr_*` tools |
| AISend | [aisend.app](https://aisend.app) | An email sending service I run. This package does **not** call it; `email_auth_check` is computed locally. |

This is not an independent or neutral toolkit. The SEO and revenue tools exist to give agents access to my own products' free public endpoints, and the data they return is only as good as those services.

### What leaves your machine

| Tool | Sent to | What is sent |
| --- | --- | --- |
| `seo_free_audit` | seobolt.app | the domain you pass |
| `seo_check` | seobolt.app | the domain or page URL you pass (and robots bots/paths if given) |
| `mrr_leaderboard`, `mrr_stats` | showmrr.com | nothing but the request itself (optional category and limit) |
| `mrr_search`, `mrr_startup` | showmrr.com | your search text, or the id/slug you pass |
| `email_auth_check` | your DNS resolver | DNS queries for the domain, `_dmarc.<domain>`, and `<selector>._domainkey.<domain>`. No third-party service. |

- Every request carries a `User-Agent` of `founder-toolkit-mcp/<version>` so the services can tell this client apart. No API key, cookie or account identifier is sent. Your IP address is visible to the services, as with any web request.
- The package contains no telemetry and makes no other network calls.
- Do not point the SEO tools at a URL that contains secrets or private tokens; the whole URL is sent.
- Because I run SEOBolt and ShowMRR, assume I can see request logs for them.

### Rate limits

The endpoints are anonymous and limited per IP address. Observed during development (2026-10-30):

- SEOBolt answers `HTTP 429` with `Retry-After: 300` and an `x-ratelimit-limit` header when you are over the limit. `llms-txt-checker` returned 429 on about the third request inside a few minutes, with `x-ratelimit-limit: 3`. The service is configured for roughly 5 free audits and 3-10 checker calls per 5 minutes per IP; I observed the 3-call limit on that one checker and did not test the others to exhaustion.
- ShowMRR: I made a few dozen requests and did not hit a limit; I have not measured what its limit is.

On a 429 the tools return an error result that names the service, the retry time, and tells the agent not to retry in a loop. Requests time out after 45 seconds (SEOBolt) and 15 seconds (ShowMRR).

## Install

Requires Node.js 20 or newer. The package is not published to npm yet; run it from a checkout:

```sh
git clone https://github.com/kienpt91/founder-toolkit-mcp.git
cd founder-toolkit-mcp
npm ci
npm run build
```

Add it to any MCP client that launches stdio servers (use the absolute path of your checkout):

```json
{
  "mcpServers": {
    "founder-toolkit": {
      "command": "node",
      "args": ["/absolute/path/to/founder-toolkit-mcp/dist/index.js"]
    }
  }
}
```

The server announces itself on stderr (`founder-toolkit-mcp ready on stdio`); stdout carries the protocol only. There are no environment variables to set.

## Tools

Each tool returns one text block: a one-line human summary, a blank line, then compact JSON. Large payloads are trimmed (long text clipped, tables and lists capped, with `...Omitted` counters and a `[truncated]` marker) and the whole output is capped at 40,000 characters.

| Tool | Input | What it does |
| --- | --- | --- |
| `seo_free_audit` | `domain` | SEOBolt's anonymous audit: overall `score`, `seoScore`, `llmScore`, and recommendations sorted critical to low with how-to-fix text. |
| `seo_check` | `tool`, `target`, optional `bots`, `paths` (robots tester only) | One focused SEOBolt checker. See below. |
| `mrr_leaderboard` | `limit` (1-50, default 10), optional `category` | ShowMRR leaderboard rows. |
| `mrr_search` | `query` | Search ShowMRR listings by name or keyword. |
| `mrr_stats` | none | Listing counts, verified count, total listed MRR, per-category totals. |
| `mrr_startup` | `idOrSlug` | One listing: MRR, verification flag, as-of date, and the public source for unclaimed listings. |
| `email_auth_check` | `domain`, optional `dkimSelectors` (up to 10) | Local DNS checks: SPF, DMARC, DKIM, MX, with findings and exact fixes. |

### `seo_check` checkers

Domain checkers take a domain (a URL is reduced to its host); page checkers take a page URL (a bare domain becomes `https://<domain>/`). Targets that are IPs, `localhost` or private/reserved names are rejected locally before anything is sent.

| `tool` | Takes | Checks |
| --- | --- | --- |
| `llms-txt-checker` | domain | `/llms.txt` and optional `llms-full.txt` |
| `ai-crawler-access-checker` | domain | whether robots.txt lets AI crawlers in |
| `chatgpt-visibility-checker` | domain | crawler reachability plus on-page signals for one popular chat assistant |
| `sitemap-checker` | domain | XML sitemap discovery and validity |
| `robots-txt-tester` | domain (+ `bots`, `paths`) | fetch robots.txt and test named bots against paths |
| `ai-citation-readiness-checker` | page URL | 12 answer-readiness signals |
| `redirect-checker` | page URL | redirect chain |
| `indexability-checker` | page URL | status, noindex, X-Robots-Tag, canonical |
| `structured-data-checker` | page URL | JSON-LD |
| `heading-structure-checker` | page URL | H1 and heading hierarchy |
| `broken-link-checker` | page URL | links found in the served HTML |
| `meta-tag-checker` | page URL | title, description, canonical, Open Graph, Twitter tags |

Which checkers take a domain and which take a URL was determined by calling each endpoint live; wrong-kind input is rejected by the service with HTTP 400. A thirteenth page on the site, `ai-visibility-checker`, answered HTTP 404 from its API route when I probed it, so it is deliberately **not** exposed.

### ShowMRR: verified versus not verified

Every ShowMRR result carries `verification: "verified"` or `"NOT verified"` (from the service's `isVerified` flag) plus a notice. A missing flag counts as not verified. Money is returned as cents plus a currency code and a formatted string such as `930,398.00 USD`. Agents must never present a NOT verified figure as verified revenue. At the time of testing the live dataset held 17 listings, none verified, and many were "Unclaimed listing" entries whose figure was read from a public page.

### `email_auth_check`

- **SPF**: exactly one `v=spf1` record; follows `include` and `redirect` to count DNS-lookup mechanisms against the limit of 10; flags `+all`/bare `all`, `?all`, a missing `all`, `ptr`, unknown terms, missing includes and include loops.
- **DMARC** at `_dmarc.<domain>`: `p`, `sp`, `pct`, `rua`; flags missing/duplicate records, `p=none`, partial `pct`, weak subdomain policy, non-`mailto:` report URIs. Missing-record findings include a starter record to publish.
- **DKIM**: looks up each selector you pass; parses `p=`, treats an empty `p=` as revoked, and reads RSA key length with Node's crypto (warns under 2048 bits, fails under 1024). Without selectors it probes `default, google, selector1, selector2, k1, s1, s2, mail, dkim, smtp` and says that finding nothing does not prove DKIM is missing.
- **MX**: lists hosts by priority, flags none, recognizes a null MX.
- DNS errors other than "no data" are reported as unknown, never as missing.

## Skills

Four portable skills live in [`skills/`](skills). Each is a `SKILL.md` with `name` and `description` frontmatter, numbered steps that call the tools above with concrete arguments, a deliverable format, and an explicit "Limits" section. Copy the folders you want into whatever directory your agent loads skills from.

| Skill | Produces |
| --- | --- |
| [`launch-seo-check`](skills/launch-seo-check/SKILL.md) | A prioritized patch checklist for a site |
| [`verify-revenue-claim`](skills/verify-revenue-claim/SKILL.md) | A verdict on a claimed MRR against ShowMRR, with the verified/not-verified rule applied |
| [`email-deliverability-check`](skills/email-deliverability-check/SKILL.md) | The exact DNS records to publish or fix |
| [`ai-search-readiness`](skills/ai-search-readiness/SKILL.md) | File-level changes for llms.txt, crawler access and structured data |

A test checks that every skill has valid frontmatter, mentions only tools the server really lists, has no dead relative links, and that each example argument object in the skills passes the real input schemas.

## Limits

- The SEO tools see server-rendered HTML only. Client-rendered pages can produce false "missing" results.
- SEOBolt scores and verdicts are that service's heuristics. They do not predict rankings or citations.
- ShowMRR covers only listed startups; absence proves nothing, and most figures are not verified.
- `email_auth_check` reads published DNS only. It cannot show that your sending service signs mail, that SPF/DKIM align with the From domain, or that mail reaches the inbox. DMARC inheritance from a parent domain and external report-address authorization are not checked. SPF `a`/`mx` mechanisms count as one lookup each without being expanded.
- Results from the free endpoints can change without notice; response shapes are checked defensively and an unexpected shape is reported as an error rather than guessed.

## Live smoke test

`npm run smoke:live` is opt-in and not part of `npm test`. It starts the real server in-process, calls every tool against the real endpoints (target `example.com` by default; override with `SMOKE_DOMAIN`, pause between SEOBolt calls with `SMOKE_PAUSE_MS`), and exits non-zero only for real failures, reporting rate limits separately.

Run on 2026-10-30 against the real services: **19 of 19 calls OK, 0 rate-limited, 0 failed** (about 1 minute with 4-second pauses). It covered all four `mrr_*` tools, `email_auth_check` for `example.com` and `github.com`, `seo_free_audit`, and all 12 `seo_check` checkers. Observed:

- `seo_free_audit` on `example.com`: score 23 (seo 32, llm 67), 12 recommendations (1 critical, 4 high, 5 medium, 2 low).
- ShowMRR: 17 startups, 0 verified; leaderboard top row Ghost at 930,398.00 USD/mo, NOT verified.
- `email_auth_check` on `example.com`: SPF `v=spf1 -all`, DMARC `p=reject` without `rua`, wildcard revoked DKIM keys, null MX. On `github.com`: SPF at exactly 10 DNS lookups, DMARC `p=quarantine`, five DKIM selectors found (two with 1024-bit keys).

The run was a single pass with a quiet IP, so it shows the endpoints answer, not that they will never rate-limit you. Anyone re-running it close to other SEOBolt usage from the same IP can see `RATE_LIMITED` rows.

## Development

```sh
npm ci
npm run typecheck
npm test            # offline: injected fake fetch and fake DNS resolver, no network
npm run build
npm run smoke:live  # opt-in, hits the real endpoints
npm run check:lockfile-age
```

Unit tests assert request URLs, methods, bodies, timeouts, 429/5xx/non-JSON handling and input validation. An end-to-end test drives the server through the SDK client over a linked in-memory transport.

Dependencies are pinned to versions at least 30 days old; see [SECURITY.md](SECURITY.md) for the policy and the advisories that remain open because their fixes are newer.

## License

MIT, see [LICENSE](LICENSE).
