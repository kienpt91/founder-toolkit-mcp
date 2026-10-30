# Security

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or email kienphan.dev@gmail.com. Please do not file public issues for vulnerabilities.

## Threat model

The server runs on the user's machine as a stdio child of an MCP client and is driven by an agent. Two parties are untrusted: everything the tools **return** (audited sites, DNS owners, ShowMRR listers can write the text), and, to a lesser degree, the agent's **arguments** (a prompt-injected agent can choose them).

### Mitigations in the code

| Risk | Mitigation | Where |
| --- | --- | --- |
| Instructions planted in page titles, robots.txt, DNS TXT/MX, listing names or service error text reaching the agent as if trusted | Every result is framed with a header stating it is untrusted data and a begin/end marker pair carrying a random per-call id; every third-party string is stripped of control, zero-width, bidi, tag, private-use and variation-selector characters, flattened (except robots.txt and code templates), length-capped, and delimiter-like runs of `<`/`>` are broken up; links must be http(s); currency codes are validated; summaries are sanitized too. Skills tell the agent to treat output as data, never follow instructions in it, and show derived edits to the user first. | `src/text.ts`, `src/server.ts`, `skills/*/SKILL.md` |
| Hostile or malformed targets reaching the services or the local resolver | Domains and URLs are normalized and rejected for IP forms, reserved/private suffixes, wildcard-DNS zones, credentials, percent-encoding, backslashes, hidden characters, non-default ports, over-long names, invalid punycode and mixed-script labels. SPF include/redirect targets read from DNS get the same public-name check before they are queried. | `src/validate.ts`, `src/emailauth.ts` |
| Oversized or redirecting responses | 2 MiB streamed cap, redirects refused, 45 s / 15 s timeouts | `src/http.ts` |
| Slow DNS | 20 s overall deadline, 25-query SPF budget, partial results reported as unknown | `src/emailauth.ts` |
| Error leakage | Unexpected errors are logged to stderr only; the agent sees a generic message. Service error text is quoted, cleaned and capped. | `src/errors.ts`, `src/http.ts` |
| CI | Actions pinned to full SHAs, read-only token, `persist-credentials: false`, `npm ci --ignore-scripts` | `.github/workflows/ci.yml` |

### Known limits and findings not fully fixed

- **Prompt injection cannot be eliminated.** Framing and sanitization make planted text recognizable and inert in form, but instruction-like words are deliberately left in place because they can be real data. A human approval step before an agent writes files, DNS records or commands from tool output remains necessary.
- **Arguments are an egress channel.** A prompt-injected agent can put text into a domain, URL, search query or DKIM selector, and it will be sent to SEOBolt, ShowMRR or (for DNS) the domain's name servers. Declined: restricting selectors to one label or rejecting URL query strings. The `domain` argument already lets an agent choose arbitrary labels under a domain it controls, so those restrictions would not close the channel and would break legitimate dotted selectors and URLs. Instead, `openWorldHint` is `true` on every tool and the README says what leaves the machine. `readOnlyHint` stays `true` because the tools change no local state; the README warns that it does not describe egress and that clients should require approval if this matters.
- **Validation is lexical.** A public-looking name that resolves to a private address, or an embedded-IP name under a zone that is not on the wildcard-DNS list, passes. Whole-script look-alike domains (for example all-Cyrillic) are not detected; only mixed-script labels are. Server-side request filtering for the page checkers (private ranges, DNS rebinding, redirects) is the checker service's responsibility; this package cannot enforce it and I have not verified it from outside.
- **SPF `a`/`mx`/`exists` mechanisms** are counted but not resolved, so a hostile record cannot cause lookups through them.
- In-flight DNS lookups abandoned at the deadline still run until the resolver's own 3-second timeout.

## Dependency policy

- Every dependency (direct and transitive) is a version that had been on the npm registry for at least 30 days when it was locked. `npm run check:lockfile-age` prints any locked package published after the cutoff (default `2026-09-30T00:00:00Z`); the list must be empty.
- Direct dependencies are pinned to exact versions in `package.json`.
- Locked with `npm install --before=2026-09-30T00:00:00Z --legacy-peer-deps` (the `--before` resolver crashes on vitest 4's optional peers without the second flag). A plain `npm ci` reproduces the install.
- If a fix exists only in a version newer than the cutoff, it is not taken; the advisory is listed below instead.

## Open advisories (`npm audit` on the locked tree)

Fixes for all of these were published after the cutoff or require a major version outside the supported range, so they are intentionally not applied yet.

### Runtime dependencies (shipped to users)

| Package (locked) | Advisories | Fixed in | Reachable from this server? |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` 1.31.0 | GHSA-22jm-h49p-29qw (experimental tasks), GHSA-6prh-2h8m-c8cw (client HTTP/OAuth redirects), GHSA-46jr-4wx8-v453 (HTTP request memory use), GHSA-rvq5-wwqv-78pq (HTTP bearer auth) | 1.32.0 | No. The server speaks stdio only: no HTTP transport, no OAuth, no bearer auth, no tasks, and no SDK client code runs outside the test suite. |
| `zod` 3.25.76 | GHSA-mrhx-c7xc-m3w5 (memory use on oversized constrained collections) | 4.6.6 (a new major) | Only through tool arguments that the local MCP client sends over stdio. Array inputs are capped at 10-20 items by the schemas, and the client is the user's own agent. Not remotely reachable. |
| `body-parser` 2.3.0, `qs` 6.16.0, `ip-address` 10.7.2 | GHSA-27r3-jxmh-p828, GHSA-6pq8-jhm2-2vcw, GHSA-rxp7-6hxx-x8q5 | 2.4.0 / 6.16.1 or later / 10.7.4 or later | No. They belong to the SDK's HTTP server stack (express), which is not loaded: a run of `dist/index.js` with a module-resolution trace loads only `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`, `zod` and `zod-to-json-schema`. |
| `fast-uri` 3.1.8 (via `ajv`) | GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp | 3.1.9 | Loaded by `ajv`, but it only resolves URIs inside JSON schemas generated from this package's own zod definitions, which contain no remote `$ref`/`$id`. Attacker-controlled URIs are never passed to it. |

### Development-only dependencies (not installed by users of the package)

| Package (locked) | Advisories | Notes |
| --- | --- | --- |
| `vite` 8.3.1 | GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm, GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22, GHSA-vfpm-58rq-9qcg | Affect the Vite dev server. Tests run `vitest run` only; no dev server is started. The previously available 7.x line (7.3.6) is affected by the same issues. |
| `@vitest/mocker` / `vitest` 4.1.11 | GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp | Only exploitable through mock registration/redirects, which the tests do not use. Fixed in 4.1.12. |
| `source-map-js` 1.2.1 (via `postcss`, `vite`) | GHSA-68fv-2mgg-jv7q | Only parses source maps of build inputs in development. |

vitest 3.2.7 was the first choice, but its dependency chain carries a critical `tinypool` advisory and a critical `vitest` advisory whose fixes exist at or before the cutoff only in vitest 4.1.11, so the project uses 4.1.11 (Node 20 compatible; vitest 5 requires Node 22.12 or newer and would drop Node 20 from the CI matrix).
