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

- Every dependency (direct and transitive) is a version that had been on the npm registry for at least 7 days when it was locked. `npm run check:lockfile-age` prints any locked package published after the cutoff (default: 7 days before now; pass an ISO timestamp to use another cutoff); the list must be empty. The current lockfile was resolved with the cutoff `2026-10-23T00:00:00Z`.
- Direct dependencies are pinned to exact versions in `package.json`.
- Installs, tests, typechecks and builds run in a throwaway container (non-root, no host home or npm config), always with `--ignore-scripts`, so install scripts cannot touch the host. CI uses `npm ci --ignore-scripts`. No package needs an install script: the only ones that declare one are `esbuild` and `fsevents` (optional), and the tests and build work without running them.
- Locked with `npm install --save-exact --ignore-scripts --before=2026-10-23T00:00:00Z`; no `--legacy-peer-deps` is needed. A plain `npm ci --ignore-scripts` reproduces the install. Development tooling (vitest 5) needs Node 22.12 or newer, which is why the supported range and the CI matrix start at 22.
- If a fix exists only in a version newer than the cutoff, it is not taken; the advisory is listed below instead.

## Open advisories (`npm audit` on the locked tree)

None. `npm audit` and `npm audit --omit=dev` both report 0 vulnerabilities for the locked tree. The update fixed the earlier `@modelcontextprotocol/sdk`, `zod`, `body-parser`, `qs`, `ip-address`, `fast-uri`, `vite`, `vitest` and `source-map-js` advisories.
