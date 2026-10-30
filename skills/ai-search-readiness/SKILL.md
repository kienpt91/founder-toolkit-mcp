---
name: ai-search-readiness
description: Check whether a site is ready to be found and cited by AI answer engines (llms.txt, AI crawler access in robots.txt, structured data, citation signals) and list the exact files to add or edit. Use when asked about AI search, llms.txt, or whether AI crawlers can read a site.
---

# AI search readiness

Checks the technical signals answer engines read and produces concrete file changes. Requires the `founder-toolkit-mcp` server (tool `seo_check`; optionally `seo_free_audit`). The domain and URLs are sent to seobolt.app.

## Inputs

- `domain` (required) and one representative content page URL (an article, docs page or product page).

## Steps

1. Call `seo_check` with `{ "tool": "llms-txt-checker", "target": "<domain>" }`. If the file is missing, take the "Minimal llms.txt" code section from the result as the starting template and fill it in from the site's real pages.
2. Call `seo_check` with `{ "tool": "ai-crawler-access-checker", "target": "<domain>" }`. Note which crawlers the result reports as blocked, and which robots.txt rule blocks them.
3. If a specific bot or path matters to the user, call `seo_check` with `{ "tool": "robots-txt-tester", "target": "<domain>", "bots": ["<bot name>"], "paths": ["/", "/docs/"] }`. Use bot names taken from step 2's output.
4. Call `seo_check` with `{ "tool": "chatgpt-visibility-checker", "target": "<domain>" }` for crawler reachability plus on-page signals of the most widely used chat assistant.
5. Call `seo_check` with `{ "tool": "ai-citation-readiness-checker", "target": "<page url>" }` and `{ "tool": "structured-data-checker", "target": "<page url>" }` for the content page.
6. If you hit a rate-limit error, stop, report what was completed and the retry time, and do not retry.

## Deliverable

```
AI search readiness: <domain>
llms.txt:        <present/missing> - <fix or file content to add>
Crawler access:  <blocked crawlers + rule to change, or "no blocks found">
Structured data: <types found / missing> - <JSON-LD snippet from the tool's code section, if it returns one>
Citation signals: <n of m present> - <top 3 missing signals with the page edit for each>
Edits: <one list of files to create/change with exact content>
```

Whether to allow a crawler is the site owner's decision. Present the trade-off (visibility versus content reuse) and let the user choose before you write a robots.txt change.

## Limits

- These are technical prerequisites, not a guarantee of being cited. No tool here can tell whether any answer engine actually mentions the site; do not claim that.
- `llms.txt` is a proposed convention; support by answer engines varies and is not verified by this skill.
- Crawler lists are the checker's own and may lag behind new crawlers.
- Only server-rendered HTML is inspected. Anonymous rate limits apply.
- For classic SEO issues (sitemap, meta tags, indexing) use [launch-seo-check](../launch-seo-check/SKILL.md).
